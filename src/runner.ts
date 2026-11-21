import { checkContact } from "./checks/contact";
import { verifyTestPortal } from "./checks/portal";
import { type ClientConfig, clientDb, getClients } from "./config/clients";
import type { AppEnv } from "./env";
import { type CanaryProperties, canaryProperties } from "./lib/canary";
import { errorMessage } from "./lib/http";
import { createHubSpotClient, type HubSpotClient } from "./lib/hubspot";
import { maskText } from "./lib/mask";
import { isWithinBusinessHours, nextOutsideBusinessHours, secondsBetween } from "./lib/time";
import { sendAlertEmail } from "./notify/email";
import { pingHealthcheck } from "./notify/healthcheck";
import { submitCanary } from "./probes/submit";
import { evaluateProbe, nextIncidentAction } from "./rules/evaluate";
import {
  assertTestPortalOutsideProduction,
  resolveSimulation,
  type Simulation,
  unavailableFetch,
} from "./simulate";
import * as store from "./store/d1";
import { rulesTriage } from "./triage";
import type { FetchLike, ProbeDetails, ProbeRow, Sleep, SourceConfig } from "./types";

export interface RunDeps {
  readonly fetchImpl?: FetchLike;
  readonly sleep?: Sleep;
}

interface RunContext {
  readonly env: AppEnv;
  readonly now: Date;
  readonly simulation: Simulation;
  readonly crm: HubSpotClient;
  readonly forms: HubSpotClient;
  /** Always the real HubSpot fetch, even under simulations (used for portal verification). */
  readonly portal: HubSpotClient;
  readonly threshold: number;
  readonly properties: CanaryProperties;
  /** Wall-clock deadline (ms since epoch) after which the run stops checking more probes. */
  readonly deadline: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly submitted: number;
  readonly checked: number;
  readonly errors: readonly string[];
}

/** Interval slack so a cron firing a few seconds early still counts as due. */
const DUE_SLACK_SECONDS = 30;

/** Stop well before the next cron tick (every 5 min) so runs never overlap. */
const RUN_BUDGET_MS = 4 * 60 * 1000;

/** Error text stored in D1 or sent to Healthchecks/Sentry: masked and bounded. */
export function safeError(message: string): string {
  return maskText(message).slice(0, 200);
}

function parseDetails(json: string | null): ProbeDetails {
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    return parsed && typeof parsed === "object"
      ? { outsideBusinessHours: false, ...(parsed as Partial<ProbeDetails>) }
      : { outsideBusinessHours: false };
  } catch {
    return { outsideBusinessHours: false };
  }
}

function buildContext(env: AppEnv, now: Date, simulation: Simulation, deps: RunDeps): RunContext {
  const common = { sleep: deps.sleep, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const crmFetch = simulation === "integration_down" ? unavailableFetch : deps.fetchImpl;
  const threshold = Number.parseInt(env.INCIDENT_THRESHOLD, 10);
  return {
    env,
    now,
    simulation,
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 2,
    properties: canaryProperties(env.PROPERTY_PREFIX),
    deadline: Date.now() + RUN_BUDGET_MS,
    crm: createHubSpotClient({
      ...common,
      ...(crmFetch ? { fetchImpl: crmFetch } : {}),
      baseUrl: env.HUBSPOT_API_BASE,
      token: env.HUBSPOT_TOKEN,
    }),
    forms: createHubSpotClient({ ...common, baseUrl: env.HUBSPOT_FORMS_BASE }),
    portal: createHubSpotClient({
      ...common,
      baseUrl: env.HUBSPOT_API_BASE,
      token: env.HUBSPOT_TOKEN,
    }),
  };
}

async function checkProbe(
  ctx: RunContext,
  client: ClientConfig,
  db: D1Database,
  source: SourceConfig,
  probe: ProbeRow,
) {
  const details = parseDetails(probe.details_json);
  const ageSeconds = secondsBetween(probe.submitted_at, ctx.now);
  if (ageSeconds < source.slaSeconds) return false;

  const facts = await checkContact(
    ctx.crm,
    probe.canary_email,
    ctx.simulation,
    ctx.env.CANARY_DOMAIN,
    ctx.properties,
  );
  const evaluation = evaluateProbe({
    ageSeconds,
    slaSeconds: source.slaSeconds,
    outsideBusinessHours: details.outsideBusinessHours,
    checkError: facts.checkError,
    contactFound: facts.contactFound,
    ownerId: facts.ownerId,
    ownerActive: facts.ownerActive,
    notifiedAtIso: facts.notifiedAtIso,
    submittedAtIso: probe.submitted_at,
  });
  const verdict = evaluation.kind === "final" ? evaluation.verdict : null;
  if (verdict) {
    await rulesTriage.triage({
      clientId: client.id,
      sourceId: source.id,
      probeId: probe.id,
      verdict,
      facts: { search: facts.statusCodes.search ?? null },
    });
  }
  const newDetails: ProbeDetails = {
    ...details,
    statusCodes: facts.statusCodes,
    ...(facts.duplicateContacts > 1 ? { duplicateContacts: facts.duplicateContacts } : {}),
    ...(facts.contactFound && !facts.testFlagSet ? { testFlagMissing: true } : {}),
    ...(facts.checkError ? { checkError: safeError(facts.checkError) } : {}),
  };
  await store.updateProbeCheck(db, {
    id: probe.id,
    checkedAt: ctx.now.toISOString(),
    contactId: facts.contactId,
    ownerId: facts.ownerId,
    ownerActive: facts.ownerActive,
    notified: facts.notifiedAtIso !== null,
    latencySeconds: evaluation.kind === "final" ? evaluation.latencySeconds : null,
    verdict,
    detailsJson: JSON.stringify(newDetails),
  });
  return true;
}

async function submitIfDue(
  ctx: RunContext,
  db: D1Database,
  source: SourceConfig,
): Promise<boolean> {
  const last = await store.lastSubmittedAt(db, source.id);
  if (last && secondsBetween(last, ctx.now) < source.intervalMinutes * 60 - DUE_SLACK_SECONDS) {
    return false;
  }
  const clock =
    ctx.simulation === "after_hours"
      ? nextOutsideBusinessHours(ctx.now, source.businessHours)
      : ctx.now;
  const outcome = await submitCanary(source, {
    forms: ctx.forms,
    canaryDomain: ctx.env.CANARY_DOMAIN,
    now: ctx.now,
    simulation: ctx.simulation,
    properties: ctx.properties,
  });
  const details: ProbeDetails = {
    outsideBusinessHours: !isWithinBusinessHours(clock, source.businessHours),
    ...(ctx.simulation === "none" ? {} : { simulation: ctx.simulation }),
    ...(outcome.error ? { submitError: safeError(outcome.error) } : {}),
  };
  await store.insertProbe(db, {
    id: outcome.probeId,
    sourceId: source.id,
    canaryEmail: outcome.canaryEmail,
    submittedAt: outcome.submittedAt,
    submitStatus: outcome.status,
    verdict: outcome.ok ? null : "SUBMIT_FAILED",
    detailsJson: JSON.stringify(details),
  });
  return true;
}

async function updateIncidents(
  ctx: RunContext,
  client: ClientConfig,
  db: D1Database,
  source: SourceConfig,
) {
  const recent = await store.recentFinalVerdicts(db, source.id, 20);
  const open = await store.getOpenIncident(db, source.id);
  const action = nextIncidentAction(
    recent.map((r) => r.verdict),
    open !== null,
    ctx.threshold,
  );
  const at = ctx.now.toISOString();
  if (action.kind === "close" && open) await store.resolveIncident(db, open.id, at);
  if (action.kind !== "open") return;

  const failing = recent.filter((r) => r.verdict !== "EXPECTED_DELAY").slice(0, ctx.threshold);
  const incidentId = crypto.randomUUID();
  await store.openIncident(db, {
    id: incidentId,
    sourceId: source.id,
    openedAt: at,
    verdict: action.verdict,
    probeIds: failing.map((r) => r.probeId),
  });
  const alert = await sendAlertEmail(ctx.env, {
    subject: `[Lead Canary] ${client.id}/${source.id}: ${action.verdict}`,
    text: `Incident opened at ${at} after ${failing.length} failing probes (${failing.map((f) => f.verdict).join(", ")}).`,
  });
  if (ctx.env.ALERTS_ENABLED === "true" && !alert.sent) {
    // Do not lose the alert silently: mark the incident and fail the run (Healthchecks /fail).
    await store.setIncidentNote(db, incidentId, `alert email failed: ${safeError(alert.reason)}`);
    throw new Error(`alert email failed for incident ${incidentId}`);
  }
}

async function runSource(ctx: RunContext, client: ClientConfig, source: SourceConfig) {
  const db = clientDb(ctx.env, client);
  await store.upsertSource(db, source);
  if (!source.enabled) return { submitted: 0, checked: 0 };

  let checked = 0;
  for (const probe of await store.listPendingProbes(db, source.id)) {
    if (Date.now() > ctx.deadline)
      throw new Error("run time budget exceeded; remaining probes deferred");
    if (await checkProbe(ctx, client, db, source, probe)) checked++;
  }
  const submitted = (await submitIfDue(ctx, db, source)) ? 1 : 0;
  await updateIncidents(ctx, client, db, source);
  return { submitted, checked };
}

/** One scheduled run across all clients and sources. */
export async function runScheduled(
  env: AppEnv,
  scheduledTime: number,
  deps: RunDeps = {},
): Promise<RunSummary> {
  const runId = crypto.randomUUID();
  const now = new Date(scheduledTime);
  await pingHealthcheck(env.HEALTHCHECKS_URL, "start", {
    runId,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  await store.startRun(env.DB_INTERNAL, runId, now.toISOString());

  let submitted = 0;
  let checked = 0;
  const errors: string[] = [];
  try {
    assertTestPortalOutsideProduction(env);
    const ctx = buildContext(env, now, resolveSimulation(env), deps);
    if (env.ENVIRONMENT !== "production")
      await verifyTestPortal(ctx.portal, env.HUBSPOT_TEST_PORTAL_ID);
    for (const client of getClients(env)) {
      await store.ensureClient(env.DB_INTERNAL, client);
      for (const source of client.sources) {
        try {
          const result = await runSource(ctx, client, source);
          submitted += result.submitted;
          checked += result.checked;
        } catch (error) {
          errors.push(`${client.id}/${source.id}: ${safeError(errorMessage(error))}`);
        }
      }
    }
  } catch (error) {
    errors.push(safeError(errorMessage(error)));
  }

  const status = errors.length === 0 ? "ok" : "failed";
  await store.finishRun(env.DB_INTERNAL, {
    id: runId,
    finishedAt: new Date().toISOString(),
    status,
    probesSubmitted: submitted,
    probesChecked: checked,
    error: errors.length ? errors.join("; ").slice(0, 1000) : null,
  });
  await pingHealthcheck(env.HEALTHCHECKS_URL, status === "ok" ? "success" : "fail", {
    runId,
    body: status === "ok" ? `submitted=${submitted} checked=${checked}` : errors.join("\n"),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { runId, submitted, checked, errors };
}

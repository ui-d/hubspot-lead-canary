import { type CanaryProperties, canaryEmail, canaryProperties, newProbeId } from "../lib/canary";
import type { HubSpotClient } from "../lib/hubspot";
import { hubspotPaths } from "../lib/hubspot-paths";
import type { Simulation } from "../simulate";
import type { SourceConfig } from "../types";

export interface SubmitOutcome {
  readonly probeId: string;
  readonly canaryEmail: string;
  readonly submittedAt: string;
  /** HTTP status of the submission; null when skipped by simulation. */
  readonly status: number | null;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface SubmitDeps {
  readonly forms: HubSpotClient;
  readonly canaryDomain: string;
  readonly now: Date;
  /** Real clock in ms; defaults to Date.now. Caps the submittedAt sent to HubSpot. */
  readonly wallClock?: () => number;
  readonly simulation: Simulation;
  readonly pageUri?: string;
  /** Custom property names; defaults to the default prefix. */
  readonly properties?: CanaryProperties;
}

/** Form fields of a canary submission. The is-test property must exist on the form (hidden field). */
export function canaryFields(
  email: string,
  properties: CanaryProperties = canaryProperties(),
): { name: string; value: string }[] {
  return [
    { name: "email", value: email },
    { name: "firstname", value: "Lead Canary" },
    { name: "lastname", value: "Canary" },
    { name: properties.isTest, value: "true" },
  ];
}

/** Submits one canary through HubSpot Forms v3 (unauthenticated endpoint). */
export async function submitCanary(source: SourceConfig, deps: SubmitDeps): Promise<SubmitOutcome> {
  const probeId = newProbeId();
  const email = canaryEmail(source.id, probeId, deps.canaryDomain);
  const submittedAt = deps.now.toISOString();
  const base = { probeId, canaryEmail: email, submittedAt };

  if (deps.simulation === "missing") {
    return { ...base, status: null, ok: true, error: null };
  }

  const result = await deps.forms.request(
    "POST",
    hubspotPaths.formSubmit(source.portalId, source.formGuid),
    {
      // HubSpot answers 400 INVALID_TIMESTAMP for a future value (fast-forwarded demo runs).
      submittedAt: String(Math.min(deps.now.getTime(), (deps.wallClock ?? Date.now)())),
      fields: canaryFields(email, deps.properties),
      context: {
        pageUri: deps.pageUri ?? "https://lead-canary.invalid/canary",
        pageName: "Lead Canary canary",
      },
    },
  );
  return result.ok
    ? { ...base, status: result.status, ok: true, error: null }
    : { ...base, status: result.status, ok: false, error: result.error };
}

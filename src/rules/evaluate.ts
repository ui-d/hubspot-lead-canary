import type { Verdict } from "../types";

/** Facts gathered by the check step. Pure data, no I/O. */
export interface CheckFacts {
  /** Seconds since submission at check time. */
  readonly ageSeconds: number;
  readonly slaSeconds: number;
  readonly outsideBusinessHours: boolean;
  /** Set when the HubSpot API could not be read (5xx after retries, 401/403, timeout). */
  readonly checkError: string | null;
  readonly contactFound: boolean;
  readonly ownerId: string | null;
  /** null = unknown (owner lookup not possible). */
  readonly ownerActive: boolean | null;
  readonly notifiedAtIso: string | null;
  readonly submittedAtIso: string;
}

export type Evaluation =
  | { readonly kind: "pending" }
  | { readonly kind: "final"; readonly verdict: Verdict; readonly latencySeconds: number | null };

const pending: Evaluation = { kind: "pending" };
const final = (verdict: Verdict, latencySeconds: number | null = null): Evaluation => ({
  kind: "final",
  verdict,
  latencySeconds,
});

/** Verdicts that business hours can excuse (the routing team is not expected to act yet). */
const EXCUSABLE: ReadonlySet<Verdict> = new Set(["MISSING", "UNASSIGNED", "NOT_NOTIFIED", "LATE"]);

function notificationLatency(facts: CheckFacts): number | null {
  if (!facts.notifiedAtIso) return null;
  const ms = Date.parse(facts.notifiedAtIso) - Date.parse(facts.submittedAtIso);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
}

/** Raw verdict ignoring business hours. */
function rawEvaluation(facts: CheckFacts): Evaluation {
  if (facts.ageSeconds < facts.slaSeconds) return pending;
  if (facts.checkError !== null) return final("CHECK_FAILED");

  const graceOver = facts.ageSeconds >= 2 * facts.slaSeconds;
  if (!facts.contactFound) return graceOver ? final("MISSING") : pending;
  if (facts.ownerId !== null && facts.ownerActive === false) return final("OWNER_INACTIVE");

  const latency = notificationLatency(facts);
  const complete = facts.ownerId !== null && latency !== null;
  if (complete) return final(latency > facts.slaSeconds ? "LATE" : "OK", latency);

  if (!graceOver) return pending;
  return facts.ownerId === null ? final("UNASSIGNED") : final("NOT_NOTIFIED");
}

/**
 * Deterministic verdict for one probe.
 * - Not yet past SLA: pending.
 * - API error: CHECK_FAILED (an integration problem, not a lost lead).
 * - Not found: pending until 2×SLA, then MISSING.
 * - Owner archived: OWNER_INACTIVE immediately.
 * - Owner + notification present: OK, or LATE if notification latency > SLA.
 * - Incomplete after 2×SLA: UNASSIGNED / NOT_NOTIFIED.
 * - Outside business hours: excusable failures become EXPECTED_DELAY as soon as SLA passed.
 */
export function evaluateProbe(facts: CheckFacts): Evaluation {
  if (facts.outsideBusinessHours && facts.ageSeconds >= facts.slaSeconds) {
    const graceAware = rawEvaluation({
      ...facts,
      ageSeconds: Math.max(facts.ageSeconds, 2 * facts.slaSeconds),
    });
    if (graceAware.kind === "final" && EXCUSABLE.has(graceAware.verdict)) {
      return final("EXPECTED_DELAY", graceAware.latencySeconds);
    }
  }
  return rawEvaluation(facts);
}

/** Verdicts that do not count toward incidents. */
const NEUTRAL: ReadonlySet<Verdict> = new Set(["EXPECTED_DELAY"]);

export type IncidentAction =
  | { readonly kind: "none" }
  | { readonly kind: "open"; readonly verdict: Verdict }
  | { readonly kind: "close" };

/**
 * @param recentNewestFirst final verdicts for one source, newest first.
 * @param hasOpenIncident whether the source already has an open/acknowledged incident.
 */
export function nextIncidentAction(
  recentNewestFirst: readonly Verdict[],
  hasOpenIncident: boolean,
  threshold: number,
): IncidentAction {
  const relevant = recentNewestFirst.filter((v) => !NEUTRAL.has(v));
  const latest = relevant[0];
  if (latest === undefined) return { kind: "none" };
  if (latest === "OK") return hasOpenIncident ? { kind: "close" } : { kind: "none" };
  if (hasOpenIncident) return { kind: "none" };

  const window = relevant.slice(0, Math.max(1, threshold));
  const allFailing = window.length >= threshold && window.every((v) => v !== "OK");
  return allFailing ? { kind: "open", verdict: latest } : { kind: "none" };
}

import type { FetchLike } from "./types";

/**
 * Demo failure simulation, controlled by env SIMULATE.
 *  - missing:          skip the real submission but record the probe as submitted.
 *  - wrong_owner:      treat the contact owner as archived in the check step.
 *  - integration_down: HubSpot API calls in the check step return 503.
 *  - after_hours:      shift the probe clock outside business hours; the routing workflow is
 *                      assumed to wait until morning, so the notification signal is ignored.
 * Only allowed when ENVIRONMENT is dev, demo or test (never production).
 */
export const SIMULATIONS = ["missing", "wrong_owner", "integration_down", "after_hours"] as const;
export type Simulation = (typeof SIMULATIONS)[number] | "none";

/** Environments in which SIMULATE may be used (allow-list, not a production blacklist). */
export const SIMULATION_ENVIRONMENTS: readonly string[] = ["dev", "demo", "test"];

export class SimulationRefusedError extends Error {
  override readonly name = "SimulationRefusedError";
}

export function resolveSimulation(env: { SIMULATE?: string; ENVIRONMENT?: string }): Simulation {
  const raw = (env.SIMULATE ?? "").trim();
  if (raw === "") return "none";
  if (!SIMULATION_ENVIRONMENTS.includes(env.ENVIRONMENT ?? "")) {
    throw new SimulationRefusedError(
      `SIMULATE is set but ENVIRONMENT=${env.ENVIRONMENT ?? "unset"} is not one of ${SIMULATION_ENVIRONMENTS.join(", ")}; refusing to run`,
    );
  }
  const match = SIMULATIONS.find((s) => s === raw);
  if (!match) throw new SimulationRefusedError(`unknown SIMULATE value: ${raw}`);
  return match;
}

/**
 * Outside production the worker may only talk to the HubSpot test portal. Prevents a demo or
 * dev deployment (possibly with SIMULATE on) from probing a real client portal by mistake.
 */
export function assertTestPortalOutsideProduction(env: {
  ENVIRONMENT?: string;
  HUBSPOT_PORTAL_ID?: string;
  HUBSPOT_TEST_PORTAL_ID?: string;
}): void {
  if (env.ENVIRONMENT === "production") return;
  if (!env.HUBSPOT_TEST_PORTAL_ID || env.HUBSPOT_PORTAL_ID !== env.HUBSPOT_TEST_PORTAL_ID) {
    throw new SimulationRefusedError(
      `ENVIRONMENT=${env.ENVIRONMENT ?? "unset"} requires HUBSPOT_PORTAL_ID to equal HUBSPOT_TEST_PORTAL_ID`,
    );
  }
}

/** fetch replacement that always answers 503, used for integration_down. */
export const unavailableFetch: FetchLike = async () =>
  new Response(JSON.stringify({ category: "SERVICE_UNAVAILABLE" }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });

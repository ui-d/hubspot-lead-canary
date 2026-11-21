import type { AppEnv } from "../env";
import type { SourceConfig } from "../types";

/** Names of env bindings that hold a per-client D1 database. */
export type ClientDbBinding = Extract<
  { [K in keyof Env]: Env[K] extends D1Database ? K : never }[keyof Env],
  `DB_CLIENT_${string}`
>;

export interface ClientConfig {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly dbBinding: ClientDbBinding;
  readonly sources: readonly SourceConfig[];
}

const DEMO_TIMEZONE = "Europe/Warsaw";

/**
 * Demo client only. Real clients get their own entry, binding and secrets (see the
 * new-client skill). Demo business hours are wide (06:00–23:00 daily) so a live demo
 * normally runs "in hours"; the after_hours simulation shifts the clock out of them.
 */
const DEFAULT_DEMO_INTERVAL_MINUTES = 60;
/** The cron fires every 5 minutes, so a shorter interval cannot be honoured. */
const MIN_INTERVAL_MINUTES = 5;
/** One day. A larger value would silently stop monitoring. */
const MAX_INTERVAL_MINUTES = 1440;

/** Minutes between demo canaries (each one creates a contact). Invalid values fall back to hourly. */
export function demoIntervalMinutes(raw: string | undefined): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isInteger(parsed) &&
    parsed >= MIN_INTERVAL_MINUTES &&
    parsed <= MAX_INTERVAL_MINUTES
    ? parsed
    : DEFAULT_DEMO_INTERVAL_MINUTES;
}

export function getClients(env: AppEnv): readonly ClientConfig[] {
  const formGuid = env.DEMO_FORM_GUID.trim();
  return [
    {
      id: "demo",
      name: "Lead Canary Demo",
      timezone: DEMO_TIMEZONE,
      dbBinding: "DB_CLIENT_DEMO",
      sources: [
        {
          id: "demo_form",
          kind: "hubspot_form",
          formGuid,
          portalId: env.HUBSPOT_PORTAL_ID,
          slaSeconds: 120,
          intervalMinutes: demoIntervalMinutes(env.DEMO_INTERVAL_MINUTES),
          businessHours: {
            timezone: DEMO_TIMEZONE,
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "06:00",
            end: "23:00",
          },
          enabled: formGuid.length > 0,
        },
      ],
    },
  ];
}

export function findClient(env: AppEnv, clientId: string): ClientConfig | undefined {
  return getClients(env).find((c) => c.id === clientId);
}

export function clientDb(env: AppEnv, client: ClientConfig): D1Database {
  return env[client.dbBinding];
}

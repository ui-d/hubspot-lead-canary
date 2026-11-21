/** Final probe verdicts. `null` in storage means "pending" (not evaluated yet). */
export const VERDICTS = [
  "OK",
  "LATE",
  "MISSING",
  "UNASSIGNED",
  "OWNER_INACTIVE",
  "NOT_NOTIFIED",
  "SUBMIT_FAILED",
  "EXPECTED_DELAY",
  "CHECK_FAILED",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Weekly business-hours window in a given IANA timezone. 0 = Sunday ... 6 = Saturday. */
export interface BusinessHours {
  readonly timezone: string;
  readonly days: readonly number[];
  /** "HH:MM", 24h. If end <= start the window crosses midnight into the next day. */
  readonly start: string;
  readonly end: string;
}

export interface SourceConfig {
  readonly id: string;
  readonly kind: "hubspot_form";
  readonly formGuid: string;
  readonly portalId: string;
  readonly slaSeconds: number;
  readonly intervalMinutes: number;
  readonly businessHours: BusinessHours;
  readonly enabled: boolean;
}

export interface ProbeRow {
  readonly id: string;
  readonly source_id: string;
  readonly canary_email: string;
  readonly submitted_at: string;
  readonly submit_status: number | null;
  readonly checked_at: string | null;
  readonly contact_id: string | null;
  readonly owner_id: string | null;
  readonly owner_active: number | null;
  readonly notified: number | null;
  readonly latency_seconds: number | null;
  readonly verdict: string | null;
  readonly details_json: string | null;
}

export interface IncidentRow {
  readonly id: string;
  readonly source_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly verdict: string;
  readonly probe_ids_json: string;
  readonly status: "open" | "acknowledged" | "resolved";
  readonly note: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: "running" | "ok" | "failed";
  readonly probes_submitted: number;
  readonly probes_checked: number;
  readonly error: string | null;
}

/** Details stored with every probe (JSON). Contains no PII beyond the canary email. */
export interface ProbeDetails {
  readonly outsideBusinessHours: boolean;
  readonly simulation?: string;
  readonly submitError?: string;
  readonly statusCodes?: Readonly<Record<string, number>>;
  readonly duplicateContacts?: number;
  readonly testFlagMissing?: boolean;
  readonly checkError?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

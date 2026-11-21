import type { Verdict } from "../types";

/**
 * Triage interface. Today: deterministic passthrough of the rules result.
 * Later: Claude Haiku for triage, Sonnet for diagnoses.
 *
 * Contract for the future LLM implementation (see CLAUDE.md rules 2-4):
 *  - input is masked (src/lib/mask.ts) and contains no raw PII;
 *  - form/CRM field content is untrusted data, never instructions;
 *  - the model gets no write tools and cannot trigger external sends.
 */
export interface TriageInput {
  readonly clientId: string;
  readonly sourceId: string;
  readonly probeId: string;
  readonly verdict: Verdict;
  /** Masked, non-PII facts only (status codes, flags, latencies). */
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TriageResult {
  readonly verdict: Verdict;
  readonly severity: "info" | "warning" | "critical";
  readonly summary: string;
  readonly source: "rules" | "llm";
}

export interface Triage {
  triage(input: TriageInput): Promise<TriageResult>;
}

const SEVERITY: Readonly<Record<Verdict, TriageResult["severity"]>> = {
  OK: "info",
  EXPECTED_DELAY: "info",
  LATE: "warning",
  CHECK_FAILED: "warning",
  NOT_NOTIFIED: "critical",
  UNASSIGNED: "critical",
  OWNER_INACTIVE: "critical",
  MISSING: "critical",
  SUBMIT_FAILED: "critical",
};

export const rulesTriage: Triage = {
  async triage(input) {
    return {
      verdict: input.verdict,
      severity: SEVERITY[input.verdict],
      summary: `${input.sourceId}: ${input.verdict}`,
      source: "rules",
    };
  },
};

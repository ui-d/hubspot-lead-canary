import { describe, expect, it } from "vitest";
import { type CheckFacts, evaluateProbe, nextIncidentAction } from "../src/rules/evaluate";
import type { Verdict } from "../src/types";

const SLA = 120;
const SUBMITTED = "2026-11-03T10:00:00.000Z";

const base: CheckFacts = {
  ageSeconds: 130,
  slaSeconds: SLA,
  outsideBusinessHours: false,
  checkError: null,
  contactFound: true,
  ownerId: "owner-1",
  ownerActive: true,
  notifiedAtIso: "2026-11-03T10:00:30.000Z",
  submittedAtIso: SUBMITTED,
};

const facts = (patch: Partial<CheckFacts> = {}): CheckFacts => ({ ...base, ...patch });
const final = (verdict: Verdict, latencySeconds: number | null = null) => ({
  kind: "final",
  verdict,
  latencySeconds,
});

describe("evaluateProbe verdicts", () => {
  it("OK with latency when owner and notification are within SLA", () => {
    expect(evaluateProbe(facts())).toEqual(final("OK", 30));
  });

  it("OK exactly at the SLA boundary of notification latency", () => {
    expect(evaluateProbe(facts({ notifiedAtIso: "2026-11-03T10:02:00.000Z" }))).toEqual(
      final("OK", 120),
    );
  });

  it("LATE when notification latency exceeds the SLA", () => {
    const result = evaluateProbe(
      facts({ ageSeconds: 300, notifiedAtIso: "2026-11-03T10:03:20.000Z" }),
    );
    expect(result).toEqual(final("LATE", 200));
  });

  it("MISSING when the contact is not found after 2x SLA", () => {
    expect(evaluateProbe(facts({ ageSeconds: 240, contactFound: false }))).toEqual(
      final("MISSING"),
    );
  });

  it("UNASSIGNED when the contact has no owner after 2x SLA", () => {
    const result = evaluateProbe(
      facts({ ageSeconds: 240, ownerId: null, ownerActive: null, notifiedAtIso: null }),
    );
    expect(result).toEqual(final("UNASSIGNED"));
  });

  it("OWNER_INACTIVE immediately once SLA has passed", () => {
    expect(evaluateProbe(facts({ ownerActive: false }))).toEqual(final("OWNER_INACTIVE", null));
  });

  it("NOT_NOTIFIED when owner exists but no notification after 2x SLA", () => {
    expect(evaluateProbe(facts({ ageSeconds: 240, notifiedAtIso: null }))).toEqual(
      final("NOT_NOTIFIED"),
    );
  });

  it("EXPECTED_DELAY for an excusable failure outside business hours", () => {
    expect(evaluateProbe(facts({ outsideBusinessHours: true, contactFound: false }))).toMatchObject(
      { kind: "final", verdict: "EXPECTED_DELAY" },
    );
  });

  it("CHECK_FAILED when the API could not be read", () => {
    expect(evaluateProbe(facts({ checkError: "contact search: HTTP 503" }))).toEqual(
      final("CHECK_FAILED"),
    );
  });
});

describe("evaluateProbe pending states", () => {
  it("is pending before the SLA, whatever the facts say", () => {
    expect(evaluateProbe(facts({ ageSeconds: 119, contactFound: false }))).toEqual({
      kind: "pending",
    });
    expect(evaluateProbe(facts({ ageSeconds: 0, checkError: "boom" }))).toEqual({
      kind: "pending",
    });
  });

  it("is pending at exactly SLA-1 and decided at SLA", () => {
    expect(evaluateProbe(facts({ ageSeconds: 119 })).kind).toBe("pending");
    expect(evaluateProbe(facts({ ageSeconds: 120 })).kind).toBe("final");
  });

  it("not found between SLA and 2x SLA stays pending (late arrival window)", () => {
    for (const ageSeconds of [120, 180, 239]) {
      expect(evaluateProbe(facts({ ageSeconds, contactFound: false }))).toEqual({
        kind: "pending",
      });
    }
    expect(evaluateProbe(facts({ ageSeconds: 240, contactFound: false }))).toEqual(
      final("MISSING"),
    );
  });

  it("late arrival: found after SLA but before 2x SLA is judged on its facts", () => {
    const result = evaluateProbe(
      facts({ ageSeconds: 200, notifiedAtIso: "2026-11-03T10:03:00.000Z" }),
    );
    expect(result).toEqual(final("LATE", 180));
  });

  it("missing owner or notification is pending until 2x SLA", () => {
    expect(evaluateProbe(facts({ ageSeconds: 200, ownerId: null, ownerActive: null }))).toEqual({
      kind: "pending",
    });
    expect(evaluateProbe(facts({ ageSeconds: 200, notifiedAtIso: null }))).toEqual({
      kind: "pending",
    });
  });
});

describe("evaluateProbe outside business hours", () => {
  const outside = (patch: Partial<CheckFacts>): CheckFacts =>
    facts({ outsideBusinessHours: true, ...patch });

  it.each([
    ["MISSING", { contactFound: false }],
    ["UNASSIGNED", { ownerId: null, ownerActive: null, notifiedAtIso: null }],
    ["NOT_NOTIFIED", { notifiedAtIso: null }],
    ["LATE", { notifiedAtIso: "2026-11-03T10:05:00.000Z" }],
  ] as const)("excuses %s as soon as SLA has passed", (_name, patch) => {
    expect(evaluateProbe(outside(patch))).toMatchObject({
      kind: "final",
      verdict: "EXPECTED_DELAY",
    });
  });

  it("does not excuse OWNER_INACTIVE", () => {
    expect(evaluateProbe(outside({ ownerActive: false }))).toMatchObject({
      verdict: "OWNER_INACTIVE",
    });
  });

  it("does not excuse CHECK_FAILED", () => {
    expect(evaluateProbe(outside({ checkError: "HTTP 503" }))).toMatchObject({
      verdict: "CHECK_FAILED",
    });
  });

  it("keeps OK as OK", () => {
    expect(evaluateProbe(outside({}))).toMatchObject({ verdict: "OK" });
  });

  it("is still pending before the SLA", () => {
    expect(evaluateProbe(outside({ ageSeconds: 60, contactFound: false }))).toEqual({
      kind: "pending",
    });
  });
});

describe("nextIncidentAction", () => {
  it("opens after threshold consecutive failures", () => {
    expect(nextIncidentAction(["MISSING", "MISSING"], false, 2)).toEqual({
      kind: "open",
      verdict: "MISSING",
    });
  });

  it("opens with the newest verdict", () => {
    expect(nextIncidentAction(["LATE", "MISSING", "OK"], false, 2)).toEqual({
      kind: "open",
      verdict: "LATE",
    });
  });

  it("does not open before the threshold", () => {
    expect(nextIncidentAction(["MISSING"], false, 2)).toEqual({ kind: "none" });
    expect(nextIncidentAction(["MISSING", "OK", "MISSING"], false, 2)).toEqual({ kind: "none" });
    expect(nextIncidentAction(["MISSING", "MISSING"], false, 3)).toEqual({ kind: "none" });
  });

  it("ignores EXPECTED_DELAY", () => {
    expect(nextIncidentAction(["EXPECTED_DELAY", "MISSING"], false, 2)).toEqual({ kind: "none" });
    expect(nextIncidentAction(["MISSING", "EXPECTED_DELAY", "MISSING"], false, 2)).toEqual({
      kind: "open",
      verdict: "MISSING",
    });
    expect(nextIncidentAction(["EXPECTED_DELAY", "EXPECTED_DELAY"], false, 2)).toEqual({
      kind: "none",
    });
    expect(nextIncidentAction([], false, 2)).toEqual({ kind: "none" });
  });

  it("closes an open incident on OK", () => {
    expect(nextIncidentAction(["OK", "MISSING", "MISSING"], true, 2)).toEqual({ kind: "close" });
  });

  it("does not close when only EXPECTED_DELAY follows failures", () => {
    expect(nextIncidentAction(["EXPECTED_DELAY", "MISSING", "MISSING"], true, 2)).toEqual({
      kind: "none",
    });
  });

  it("does nothing on OK without an open incident", () => {
    expect(nextIncidentAction(["OK", "OK"], false, 2)).toEqual({ kind: "none" });
  });

  it("does not open a second incident while one is open", () => {
    expect(nextIncidentAction(["MISSING", "MISSING", "MISSING"], true, 2)).toEqual({
      kind: "none",
    });
  });
});

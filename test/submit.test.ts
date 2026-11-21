import { describe, expect, it, vi } from "vitest";
import { canaryProperties } from "../src/lib/canary";
import { createHubSpotClient } from "../src/lib/hubspot";
import { canaryFields, submitCanary } from "../src/probes/submit";
import type { SourceConfig } from "../src/types";

const SOURCE: SourceConfig = {
  id: "demo_form",
  kind: "hubspot_form",
  formGuid: "11111111-1111-1111-1111-111111111111",
  portalId: "1000",
  slaSeconds: 120,
  intervalMinutes: 5,
  businessHours: { timezone: "Europe/Warsaw", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  enabled: true,
};

const REAL_NOW = Date.parse("2026-11-20T14:00:00.000Z");

async function submittedAtFor(now: Date): Promise<{ sent: string; stored: string }> {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ inlineMessage: "ok" }),
  );
  const outcome = await submitCanary(SOURCE, {
    forms: createHubSpotClient({ baseUrl: "https://forms.test", fetchImpl }),
    canaryDomain: "example.com",
    now,
    wallClock: () => REAL_NOW,
    simulation: "none",
  });
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { submittedAt: string };
  return { sent: body.submittedAt, stored: outcome.submittedAt };
}

describe("submitCanary submittedAt", () => {
  it("sends the scheduled time when it is not in the future", async () => {
    const now = new Date(REAL_NOW - 2_000);
    const { sent, stored } = await submittedAtFor(now);
    expect(sent).toBe(String(now.getTime()));
    expect(stored).toBe(now.toISOString());
  });

  it("caps a fast-forwarded time at the real clock, since HubSpot rejects future timestamps", async () => {
    const now = new Date(REAL_NOW + 30 * 60_000);
    const { sent, stored } = await submittedAtFor(now);
    expect(sent).toBe(String(REAL_NOW));
    // The probe row keeps the scheduled time so SLA arithmetic stays on one clock.
    expect(stored).toBe(now.toISOString());
  });
});

describe("canaryFields", () => {
  it("marks the submission with the default is-test property", () => {
    expect(canaryFields("canary+demo_form-abcdef012345@example.com")).toContainEqual({
      name: "leadcanary_is_test",
      value: "true",
    });
  });

  it("uses the configured property prefix", () => {
    const fields = canaryFields(
      "canary+demo_form-abcdef012345@example.com",
      canaryProperties("acme"),
    );
    expect(fields).toContainEqual({ name: "acme_is_test", value: "true" });
    expect(fields.map((f) => f.name)).not.toContain("leadcanary_is_test");
  });
});

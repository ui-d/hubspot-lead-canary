import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  finishRun,
  getOpenIncident,
  insertProbe,
  lastRun,
  lastSubmittedAt,
  listPendingProbes,
  openIncident,
  recentFinalVerdicts,
  resolveIncident,
  startRun,
  updateProbeCheck,
  upsertSource,
} from "../src/store/d1";
import type { SourceConfig } from "../src/types";

const source: SourceConfig = {
  id: "store_src",
  kind: "hubspot_form",
  formGuid: "00000000-0000-0000-0000-000000000000",
  portalId: "1000",
  slaSeconds: 120,
  intervalMinutes: 5,
  businessHours: { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
  enabled: true,
};

describe("store/d1 round trip", () => {
  it("stores probes, updates checks and lists verdicts", async () => {
    const db = env.DB_CLIENT_DEMO;
    await upsertSource(db, source);
    await upsertSource(db, { ...source, slaSeconds: 300 });
    const row = await db
      .prepare("SELECT sla_seconds FROM sources WHERE id = ?1")
      .bind(source.id)
      .first();
    expect(row).toEqual({ sla_seconds: 300 });

    await insertProbe(db, {
      id: "p1",
      sourceId: source.id,
      canaryEmail: "canary+store_src-aaaaaaaaaaaa@canary.test",
      submittedAt: "2026-11-03T10:00:00.000Z",
      submitStatus: 200,
      verdict: null,
      detailsJson: "{}",
    });
    expect(await lastSubmittedAt(db, source.id)).toBe("2026-11-03T10:00:00.000Z");
    expect((await listPendingProbes(db, source.id)).map((p) => p.id)).toEqual(["p1"]);

    await updateProbeCheck(db, {
      id: "p1",
      checkedAt: "2026-11-03T10:05:00.000Z",
      contactId: "c1",
      ownerId: "o1",
      ownerActive: true,
      notified: true,
      latencySeconds: 42,
      verdict: "OK",
      detailsJson: "{}",
    });
    expect(await listPendingProbes(db, source.id)).toEqual([]);
    expect(await recentFinalVerdicts(db, source.id, 5)).toEqual([{ probeId: "p1", verdict: "OK" }]);
  });

  it("opens and resolves incidents", async () => {
    const db = env.DB_CLIENT_DEMO;
    await upsertSource(db, source);
    await openIncident(db, {
      id: "i1",
      sourceId: source.id,
      openedAt: "2026-11-03T10:00:00.000Z",
      verdict: "MISSING",
      probeIds: ["p1", "p2"],
    });
    expect((await getOpenIncident(db, source.id))?.id).toBe("i1");
    await resolveIncident(db, "i1", "2026-11-03T11:00:00.000Z");
    expect(await getOpenIncident(db, source.id)).toBeNull();
  });

  it("tracks runs in the internal database", async () => {
    const db = env.DB_INTERNAL;
    await startRun(db, "r1", "2026-11-03T10:00:00.000Z");
    await finishRun(db, {
      id: "r1",
      finishedAt: "2026-11-03T10:00:05.000Z",
      status: "ok",
      probesSubmitted: 1,
      probesChecked: 2,
      error: null,
    });
    expect(await lastRun(db)).toMatchObject({ id: "r1", status: "ok", probes_checked: 2 });
  });
});

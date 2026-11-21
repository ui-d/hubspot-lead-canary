import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { type RunSummary, runScheduled } from "../src/runner";
import { getOpenIncident } from "../src/store/d1";
import type { FetchLike } from "../src/types";

const FORM_GUID = "11111111-1111-1111-1111-111111111111";
const SOURCE = "demo_form";
const T0 = Date.parse("2026-11-03T10:00:00.000Z"); // 11:00 in Warsaw, inside business hours
const NOTIFY_DELAY_MS = 30_000;

interface World {
  /** canary email -> submission time (ms). */
  submissions: Map<string, number>;
  /** All outgoing requests as "METHOD url". */
  requests: string[];
  pings: string[];
  formStatus: number;
  ownerId: string | null;
  accountType: string;
}

function createWorld(): World {
  return {
    submissions: new Map(),
    requests: [],
    pings: [],
    formStatus: 200,
    ownerId: "owner-1",
    accountType: "DEVELOPER_TEST",
  };
}

/** Routes by URL like HubSpot would. Never touches the network. */
function fakeFetch(world: World): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    world.requests.push(`${init?.method ?? "GET"} ${input}`);

    if (url.hostname === "hc.test") {
      world.pings.push(url.pathname);
      return new Response("OK", { status: 200 });
    }
    if (url.hostname === "api.hsforms.com") {
      if (world.formStatus !== 200) {
        return Response.json({ message: "bad" }, { status: world.formStatus });
      }
      const body = JSON.parse(String(init?.body)) as {
        submittedAt: string;
        fields: { name: string; value: string }[];
      };
      const email = body.fields.find((f) => f.name === "email")?.value ?? "";
      world.submissions.set(email, Number(body.submittedAt));
      return Response.json({ inlineMessage: "ok" });
    }
    if (url.hostname === "api.hubapi.com" && url.pathname.endsWith("/contacts/search")) {
      const parsed = JSON.parse(String(init?.body)) as {
        filterGroups: { filters: { value: string }[] }[];
      };
      const email = parsed.filterGroups[0]?.filters[0]?.value ?? "";
      const submittedAt = world.submissions.get(email);
      if (submittedAt === undefined) return Response.json({ total: 0, results: [] });
      const properties: Record<string, string> = {
        email,
        leadcanary_is_test: "true",
        leadcanary_notified_at: new Date(submittedAt + NOTIFY_DELAY_MS).toISOString(),
        ...(world.ownerId ? { hubspot_owner_id: world.ownerId } : {}),
      };
      return Response.json({ total: 1, results: [{ id: "contact-1", properties }] });
    }
    if (url.hostname === "api.hubapi.com" && url.pathname.startsWith("/account-info/")) {
      return Response.json({ portalId: 1000, accountType: world.accountType });
    }
    if (url.hostname === "api.hubapi.com" && url.pathname.includes("/owners/")) {
      return Response.json({ id: world.ownerId, archived: false });
    }
    return new Response("unexpected", { status: 599 });
  };
}

const baseEnv = (patch: Record<string, string> = {}): AppEnv =>
  ({ ...env, DEMO_FORM_GUID: FORM_GUID, ...patch }) as AppEnv;

const noSleep = async (): Promise<void> => {};

let world: World;
const run = (overrides: Record<string, string>, atSeconds: number): Promise<RunSummary> =>
  runScheduled(baseEnv(overrides), T0 + atSeconds * 1000, {
    fetchImpl: fakeFetch(world),
    sleep: noSleep,
  });

async function verdicts(): Promise<(string | null)[]> {
  const { results } = await env.DB_CLIENT_DEMO.prepare(
    "SELECT verdict FROM probes ORDER BY submitted_at ASC",
  ).all<{ verdict: string | null }>();
  return results.map((r) => r.verdict);
}

const openIncident = () => getOpenIncident(env.DB_CLIENT_DEMO, SOURCE);
const incidentCount = async (): Promise<number> =>
  (await env.DB_CLIENT_DEMO.prepare("SELECT COUNT(*) AS n FROM incidents").first<{ n: number }>())
    ?.n ?? 0;

beforeEach(async () => {
  world = createWorld();
  await env.DB_CLIENT_DEMO.exec("DELETE FROM incidents");
  await env.DB_CLIENT_DEMO.exec("DELETE FROM probes");
  await env.DB_CLIENT_DEMO.exec("DELETE FROM sources");
  await env.DB_INTERNAL.exec("DELETE FROM runs");
});

describe("runScheduled happy path", () => {
  it("first run submits one probe and pings /start and success", async () => {
    const summary = await run({}, 0);
    expect(summary).toMatchObject({ submitted: 1, checked: 0, errors: [] });
    expect(world.submissions.size).toBe(1);
    expect([...world.submissions.keys()][0]).toMatch(
      /^canary\+demo_form-[a-f0-9]{12}@canary\.test$/,
    );
    expect(world.pings).toEqual(["/ping/abc/start", "/ping/abc"]);
    expect(await verdicts()).toEqual([null]);
  });

  it("second run 3 minutes later checks the probe -> OK", async () => {
    await run({}, 0);
    const summary = await run({}, 180);
    expect(summary).toMatchObject({ submitted: 0, checked: 1, errors: [] });
    expect(await verdicts()).toEqual(["OK"]);
    const row = await env.DB_CLIENT_DEMO.prepare(
      "SELECT latency_seconds, owner_active, notified FROM probes",
    ).first();
    expect(row).toEqual({ latency_seconds: 30, owner_active: 1, notified: 1 });
    expect(await openIncident()).toBeNull();
  });

  it("does not submit again before the interval has elapsed", async () => {
    await run({}, 0);
    const summary = await run({}, 60);
    expect(summary.submitted).toBe(0);
    expect(summary.checked).toBe(0); // age 60 < SLA
    expect(world.submissions.size).toBe(1);
  });

  it("records the run in the internal database", async () => {
    await run({}, 0);
    const run1 = await env.DB_INTERNAL.prepare("SELECT status, probes_submitted FROM runs").first();
    expect(run1).toEqual({ status: "ok", probes_submitted: 1 });
  });

  it("does nothing for a disabled source (no DEMO_FORM_GUID)", async () => {
    const summary = await runScheduled(baseEnv({ DEMO_FORM_GUID: "" }), T0, {
      fetchImpl: fakeFetch(world),
      sleep: noSleep,
    });
    expect(summary).toMatchObject({ submitted: 0, checked: 0, errors: [] });
    expect(world.submissions.size).toBe(0);
  });
});

describe("SIMULATE=missing", () => {
  const sim = { SIMULATE: "missing" };

  it("stays pending until 2x SLA, then MISSING", async () => {
    await run(sim, 0);
    expect(world.submissions.size).toBe(0); // nothing really submitted
    await run(sim, 180);
    expect(await verdicts()).toEqual([null]);
    await run(sim, 240);
    expect(await verdicts()).toEqual(["MISSING"]);
  });

  it("two consecutive MISSING open an incident; a following OK closes it", async () => {
    await run(sim, 0); // P1 submitted (simulated)
    await run(sim, 240); // P1 -> MISSING
    expect(await openIncident()).toBeNull();
    await run(sim, 300); // P2 submitted
    await run(sim, 540); // P2 -> MISSING, incident opens
    expect(await verdicts()).toEqual(["MISSING", "MISSING"]);
    const incident = await openIncident();
    expect(incident).toMatchObject({ source_id: SOURCE, verdict: "MISSING", status: "open" });

    await run({}, 600); // simulation off: P3 submitted for real
    await run({}, 780); // P3 -> OK, closes incident
    expect(await verdicts()).toEqual(["MISSING", "MISSING", "OK"]);
    expect(await openIncident()).toBeNull();
    const closed = await env.DB_CLIENT_DEMO.prepare(
      "SELECT status, closed_at FROM incidents",
    ).first();
    expect(closed).toEqual({ status: "resolved", closed_at: new Date(T0 + 780_000).toISOString() });
  });

  it("does not open a second incident while one is open", async () => {
    await run(sim, 0);
    await run(sim, 240);
    await run(sim, 300);
    await run(sim, 540);
    await run(sim, 600); // P3
    await run(sim, 840); // P3 -> MISSING while incident is open
    expect(await incidentCount()).toBe(1);
  });
});

describe("other simulations", () => {
  it("wrong_owner -> OWNER_INACTIVE", async () => {
    await run({ SIMULATE: "wrong_owner" }, 0);
    await run({ SIMULATE: "wrong_owner" }, 180);
    expect(await verdicts()).toEqual(["OWNER_INACTIVE"]);
  });

  it("integration_down -> CHECK_FAILED, submission still goes through", async () => {
    await run({ SIMULATE: "integration_down" }, 0);
    expect(world.submissions.size).toBe(1);
    const summary = await run({ SIMULATE: "integration_down" }, 180);
    expect(summary.errors).toEqual([]);
    expect(await verdicts()).toEqual(["CHECK_FAILED"]);
    // CRM calls were swallowed by the simulated outage; only portal verification reached HubSpot.
    const crmCalls = world.requests.filter(
      (r) => r.includes("api.hubapi.com") && !r.includes("/account-info/"),
    );
    expect(crmCalls).toEqual([]);
  });

  it("after_hours -> EXPECTED_DELAY and no incident", async () => {
    const sim = { SIMULATE: "after_hours" };
    await run(sim, 0);
    const details = await env.DB_CLIENT_DEMO.prepare("SELECT details_json FROM probes").first<{
      details_json: string;
    }>();
    expect(JSON.parse(details?.details_json ?? "{}")).toMatchObject({
      outsideBusinessHours: true,
      simulation: "after_hours",
    });
    await run(sim, 180);
    await run(sim, 360); // second probe submitted at 360? (>= 270 after first) -> checked later
    await run(sim, 600);
    const all = await verdicts();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.slice(0, 2)).toEqual(["EXPECTED_DELAY", "EXPECTED_DELAY"]);
    expect(await incidentCount()).toBe(0);
  });
});

describe("failure handling", () => {
  it("submission 400 -> SUBMIT_FAILED", async () => {
    world.formStatus = 400;
    const summary = await run({}, 0);
    expect(summary.submitted).toBe(1);
    expect(await verdicts()).toEqual(["SUBMIT_FAILED"]);
    const row = await env.DB_CLIENT_DEMO.prepare(
      "SELECT submit_status, details_json FROM probes",
    ).first<{
      submit_status: number;
      details_json: string;
    }>();
    expect(row?.submit_status).toBe(400);
    expect(JSON.parse(row?.details_json ?? "{}")).toMatchObject({ submitError: "HTTP 400" });
  });

  it("production + SIMULATE set -> errors, /fail ping and no submission", async () => {
    const summary = await run({ ENVIRONMENT: "production", SIMULATE: "missing" }, 0);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.errors.join(" ")).toMatch(/SIMULATE/);
    expect(world.pings).toEqual(["/ping/abc/start", "/ping/abc/fail"]);
    expect(await verdicts()).toEqual([]);
    const row = await env.DB_INTERNAL.prepare("SELECT status FROM runs").first();
    expect(row).toEqual({ status: "failed" });
  });

  it("portal id mismatch outside production is refused", async () => {
    const summary = await run({ HUBSPOT_PORTAL_ID: "2000" }, 0);
    expect(summary.errors.join(" ")).toMatch(/HUBSPOT_PORTAL_ID/);
    expect(summary).toMatchObject({ submitted: 0, checked: 0 });
    expect(world.requests.filter((r) => !r.includes("hc.test"))).toEqual([]);
    expect(world.pings).toEqual(["/ping/abc/start", "/ping/abc/fail"]);
  });

  it("unknown SIMULATE value is refused", async () => {
    const summary = await run({ SIMULATE: "bogus" }, 0);
    expect(summary.errors.join(" ")).toMatch(/unknown SIMULATE/);
  });

  it("SIMULATE is refused in any environment outside the allow-list", async () => {
    const summary = await run({ ENVIRONMENT: "prod", SIMULATE: "missing" }, 0);
    expect(summary.errors.join(" ")).toMatch(/not one of dev, demo, test/);
    expect(await verdicts()).toEqual([]);
  });

  it("refuses to run when the token's portal is not a developer test account", async () => {
    world.accountType = "STANDARD";
    const summary = await run({}, 0);
    expect(summary.errors.join(" ")).toMatch(/not DEVELOPER_TEST/);
    expect(world.submissions.size).toBe(0);
    expect(world.pings).toEqual(["/ping/abc/start", "/ping/abc/fail"]);
  });

  it("an incident whose alert email fails is noted and fails the run", async () => {
    // ALERTS_ENABLED without Resend config -> send fails -> must not be silent.
    const patch = { SIMULATE: "missing", ALERTS_ENABLED: "true" };
    await run(patch, 0);
    await run(patch, 300);
    const summary = await run(patch, 600);
    expect(summary.errors.join(" ")).toMatch(/alert email failed/);
    const incident = await getOpenIncident(env.DB_CLIENT_DEMO, SOURCE);
    expect(incident?.note).toMatch(/alert email failed/);
  });
});

describe("HTTP endpoints", () => {
  it("GET /health returns JSON with the last run", async () => {
    await run({}, 0);
    const res = await exports.default.fetch("http://worker.test/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: true, lastRunStatus: "ok" });
  });

  it("GET /report is 401 without a token", async () => {
    const res = await exports.default.fetch("http://worker.test/report?client=demo");
    expect(res.status).toBe(401);
  });

  it("GET /report is 401 with a wrong token", async () => {
    const res = await exports.default.fetch("http://worker.test/report?client=demo", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /report returns HTML with the admin token", async () => {
    // The report covers the last 24h of the real clock, so the probe must be submitted "now".
    await runScheduled(baseEnv(), Date.now(), { fetchImpl: fakeFetch(world), sleep: noSleep });
    const res = await exports.default.fetch("http://worker.test/report?client=demo", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Lead Canary");
    expect(html).toContain(SOURCE);
  });

  it("GET /report with an unknown client is 404", async () => {
    const res = await exports.default.fetch("http://worker.test/report?client=nope", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-GET methods and unknown paths", async () => {
    const post = await exports.default.fetch("http://worker.test/health", { method: "POST" });
    expect(post.status).toBe(405);
    const missing = await exports.default.fetch("http://worker.test/nope");
    expect(missing.status).toBe(404);
  });
});

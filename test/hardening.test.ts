import { describe, expect, it, vi } from "vitest";
import { createHubSpotClient, retryDelayMs } from "../src/lib/hubspot";
import { pingHealthcheck } from "../src/notify/healthcheck";
import { escapeHtml } from "../src/report";
import { safeError } from "../src/runner";

const okFetch = () =>
  vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));

describe("HubSpot client is read-only by default", () => {
  it("blocks authenticated POSTs that are not searches", async () => {
    const fetchImpl = okFetch();
    const crm = createHubSpotClient({ baseUrl: "https://crm.test", token: "fake", fetchImpl });
    const res = await crm.request("POST", "/crm/objects/2026-09/contacts", { properties: {} });
    expect(res).toMatchObject({ ok: false, error: "write blocked: read-only client" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows authenticated search POSTs", async () => {
    const fetchImpl = okFetch();
    const crm = createHubSpotClient({ baseUrl: "https://crm.test", token: "fake", fetchImpl });
    expect((await crm.request("POST", "/crm/objects/2026-09/contacts/search", {})).ok).toBe(true);
  });

  it("allows writes only when explicitly enabled (setup script)", async () => {
    const fetchImpl = okFetch();
    const crm = createHubSpotClient({
      baseUrl: "https://crm.test",
      token: "fake",
      fetchImpl,
      allowWrites: true,
    });
    expect((await crm.request("POST", "/crm/properties/2026-09/contacts", {})).ok).toBe(true);
  });

  it("allows unauthenticated form submissions", async () => {
    const fetchImpl = okFetch();
    const forms = createHubSpotClient({ baseUrl: "https://forms.test", fetchImpl });
    expect((await forms.request("POST", "/submissions/v3/integration/submit/1/x", {})).ok).toBe(
      true,
    );
  });

  it("refuses redirects", async () => {
    const fetchImpl = okFetch();
    const crm = createHubSpotClient({ baseUrl: "https://crm.test", token: "fake", fetchImpl });
    await crm.request("GET", "/x");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("treats a redirect response as a failure and does not retry it", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    );
    const crm = createHubSpotClient({ baseUrl: "https://crm.test", token: "fake", fetchImpl });
    expect(await crm.request("GET", "/x")).toMatchObject({ ok: false, status: 302, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not echo arbitrary error categories", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ category: "leak user@example.com" }, { status: 400 }),
    );
    const crm = createHubSpotClient({ baseUrl: "https://crm.test", token: "fake", fetchImpl });
    expect(await crm.request("GET", "/x")).toMatchObject({ ok: false, error: "HTTP 400" });
  });

  it("treats an empty Retry-After header as absent", () => {
    const delay = retryDelayMs(2, "  ", { baseDelayMs: 500, maxDelayMs: 10_000, random: () => 1 });
    expect(delay).toBe(2000);
  });
});

describe("Healthchecks ping", () => {
  it("never sends the ping URL over plain http", async () => {
    const fetchImpl = okFetch();
    expect(await pingHealthcheck("http://hc.test/ping/abc", "start", { fetchImpl })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not throw on a malformed URL", async () => {
    expect(await pingHealthcheck("not a url", "success")).toBe(0);
  });
});

describe("output sanitising", () => {
  it("masks emails and bounds error text", () => {
    const masked = safeError(`failed for jane.doe@example.com ${"x".repeat(500)}`);
    expect(masked).not.toContain("jane.doe@example.com");
    expect(masked.length).toBeLessThanOrEqual(200);
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });
});

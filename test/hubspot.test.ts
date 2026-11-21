import { describe, expect, it, vi } from "vitest";
import { createHubSpotClient, retryDelayMs } from "../src/lib/hubspot";
import type { FetchLike } from "../src/types";

const BASE = "https://api.hubspot.test";

type Step = () => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Step => {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
};
const failWith = (error: Error): Step => {
  return () => {
    throw error;
  };
};

/** Fetch fake that plays the given steps in order and records every call. */
function scripted(steps: readonly Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (!step) throw new Error("no scripted step");
    return step();
  };
  return { fetchImpl, calls };
}

function setup(steps: readonly Step[], options: { token?: string; maxRetries?: number } = {}) {
  const { fetchImpl, calls } = scripted(steps);
  const sleep = vi.fn(async (_ms: number) => {});
  const client = createHubSpotClient({
    baseUrl: BASE,
    fetchImpl,
    sleep,
    random: () => 0,
    ...options,
  });
  return { client, calls, sleep };
}

describe("createHubSpotClient retries", () => {
  it("returns success on the first try without sleeping", async () => {
    const { client, calls, sleep } = setup([json(200, { id: "1" })]);
    const result = await client.request("GET", "/x");
    expect(result).toEqual({ ok: true, status: 200, data: { id: "1" }, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/x`);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honours Retry-After on 429 and then succeeds", async () => {
    const { client, sleep } = setup([
      json(429, { category: "RATE_LIMITS" }, { "retry-after": "2" }),
      json(200, { ok: 1 }),
    ]);
    const result = await client.request("GET", "/x");
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries 5xx with backoff and then succeeds", async () => {
    const { client, sleep } = setup([json(503, {}), json(502, {}), json(200, { ok: 1 })]);
    const result = await client.request("POST", "/x", { a: 1 });
    expect(result).toMatchObject({ ok: true, status: 200, attempts: 3 });
    // random() = 0 -> half of the ceiling: 250 then 500.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it("returns a non-retryable 400 immediately", async () => {
    const { client, calls, sleep } = setup([json(400, { category: "VALIDATION_ERROR" })]);
    const result = await client.request("POST", "/x", {});
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "HTTP 400 VALIDATION_ERROR",
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("does not retry %i", async (status) => {
    const { client, calls } = setup([json(status, {})]);
    const result = await client.request("GET", "/x");
    expect(result).toMatchObject({ ok: false, status, error: `HTTP ${status}`, attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries+1 attempts on persistent 5xx", async () => {
    const { client, calls, sleep } = setup([json(503, {})], { maxRetries: 2 });
    const result = await client.request("GET", "/x");
    expect(result).toMatchObject({ ok: false, status: 503, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports status 0 after maxRetries+1 network errors", async () => {
    const { client, calls, sleep } = setup([failWith(new Error("socket hang up"))], {
      maxRetries: 2,
    });
    const result = await client.request("GET", "/x");
    expect(result).toEqual({ ok: false, status: 0, error: "socket hang up", attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports timeouts as status 0 with a 'timeout' error", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { client, calls } = setup([failWith(timeout)], { maxRetries: 1 });
    const result = await client.request("GET", "/x");
    expect(result).toEqual({ ok: false, status: 0, error: "timeout", attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it("recovers from a network error", async () => {
    const { client } = setup([failWith(new Error("reset")), json(200, { ok: 1 })]);
    expect(await client.request("GET", "/x")).toMatchObject({ ok: true, attempts: 2 });
  });

  it("attaches an abort signal to every attempt", async () => {
    const { client, calls } = setup([json(200, {})]);
    await client.request("GET", "/x");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("tolerates empty and non-JSON bodies", async () => {
    const empty = setup([() => new Response(null, { status: 204 })]);
    expect(await empty.client.request("GET", "/x")).toMatchObject({ ok: true, data: null });
    const html = setup([() => new Response("<html>", { status: 200 })]);
    expect(await html.client.request("GET", "/x")).toMatchObject({ ok: true, data: null });
  });
});

describe("createHubSpotClient request shape", () => {
  it("sends Authorization only when a token is set", async () => {
    const withToken = setup([json(200, {})], { token: "fake-test-token" });
    await withToken.client.request("GET", "/x");
    expect(withToken.calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer fake-test-token",
    });

    const without = setup([json(200, {})]);
    await without.client.request("GET", "/x");
    const headers = without.calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers)).not.toContain("authorization");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("does not send Authorization with an empty token", async () => {
    const { client, calls } = setup([json(200, {})], { token: "" });
    await client.request("GET", "/x");
    expect(Object.keys(calls[0]?.init.headers as Record<string, string>)).not.toContain(
      "authorization",
    );
  });

  it("serialises the body for POST and omits it for GET", async () => {
    const post = setup([json(200, {})]);
    await post.client.request("POST", "/x", { a: 1 });
    expect(post.calls[0]?.init.method).toBe("POST");
    expect(post.calls[0]?.init.body).toBe('{"a":1}');

    const get = setup([json(200, {})]);
    await get.client.request("GET", "/x");
    expect(get.calls[0]?.init.body).toBeUndefined();
  });
});

describe("retryDelayMs bounds", () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 10_000 };

  it("uses Retry-After in seconds", () => {
    expect(retryDelayMs(0, "2", { ...opts, random: () => 0.5 })).toBe(2000);
    expect(retryDelayMs(0, "0", { ...opts, random: () => 0.5 })).toBe(0);
  });

  it("caps Retry-After at maxDelayMs", () => {
    expect(retryDelayMs(0, "3600", { ...opts, random: () => 0 })).toBe(10_000);
  });

  it("falls back to backoff for unusable Retry-After values", () => {
    for (const value of ["abc", "-5", "Wed, 21 Oct 2026 07:28:00 GMT", null]) {
      expect(retryDelayMs(0, value, { ...opts, random: () => 0 })).toBe(250);
    }
  });

  it("backs off between half the ceiling and the ceiling", () => {
    expect(retryDelayMs(0, null, { ...opts, random: () => 0 })).toBe(250);
    expect(retryDelayMs(0, null, { ...opts, random: () => 1 })).toBe(500);
    expect(retryDelayMs(2, null, { ...opts, random: () => 0 })).toBe(1000);
    expect(retryDelayMs(2, null, { ...opts, random: () => 1 })).toBe(2000);
  });

  it("never exceeds maxDelayMs and stays within [max/2, max] once capped", () => {
    for (const random of [0, 0.25, 0.99, 1]) {
      const delay = retryDelayMs(30, null, { ...opts, random: () => random });
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(10_000);
    }
  });
});

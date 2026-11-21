import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { demoIntervalMinutes, getClients } from "../src/config/clients";
import type { AppEnv } from "../src/env";

describe("demoIntervalMinutes", () => {
  it("uses a valid whole number of minutes", () => {
    expect(demoIntervalMinutes("5")).toBe(5);
    expect(demoIntervalMinutes(" 60 ")).toBe(60);
  });

  it.each([undefined, "", "abc", "0", "-5", "4", "7.5", "1441", "1e9"])(
    "falls back to hourly for %j",
    (raw) => {
      expect(demoIntervalMinutes(raw)).toBe(60);
    },
  );
});

describe("getClients", () => {
  const withEnv = (patch: Record<string, string>): AppEnv => ({ ...env, ...patch }) as AppEnv;

  it("applies DEMO_INTERVAL_MINUTES to the demo source", () => {
    const [client] = getClients(withEnv({ DEMO_FORM_GUID: "guid", DEMO_INTERVAL_MINUTES: "15" }));
    expect(client?.sources[0]).toMatchObject({ intervalMinutes: 15, enabled: true });
  });

  it("disables the demo source without a form GUID", () => {
    const [client] = getClients(withEnv({ DEMO_FORM_GUID: " " }));
    expect(client?.sources[0]?.enabled).toBe(false);
  });
});

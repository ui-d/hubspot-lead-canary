import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("serves /health", async () => {
    const res = await exports.default.fetch("http://worker.test/health");
    expect(res.status).toBe(200);
  });

  it("has migrated client tables", async () => {
    const row = await env.DB_CLIENT_DEMO.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probes'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("probes");
  });
});

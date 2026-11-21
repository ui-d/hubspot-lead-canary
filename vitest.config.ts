import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const internalMigrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations/internal"),
  );
  const clientMigrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations/client"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only values. Never real secrets.
          bindings: {
            ENVIRONMENT: "test",
            SIMULATE: "",
            ALERTS_ENABLED: "false",
            INCIDENT_THRESHOLD: "2",
            DEMO_INTERVAL_MINUTES: "5",
            HUBSPOT_TOKEN: "test-token",
            HUBSPOT_PORTAL_ID: "1000",
            HUBSPOT_TEST_PORTAL_ID: "1000",
            CANARY_DOMAIN: "canary.test",
            HEALTHCHECKS_URL: "https://hc.test/ping/abc",
            ADMIN_TOKEN: "test-admin-token",
            TEST_INTERNAL_MIGRATIONS: internalMigrations,
            TEST_CLIENT_MIGRATIONS: clientMigrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});

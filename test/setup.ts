import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file. Migrations are idempotent (tracked in d1_migrations).
await applyD1Migrations(env.DB_INTERNAL, env.TEST_INTERNAL_MIGRATIONS);
await applyD1Migrations(env.DB_CLIENT_DEMO, env.TEST_CLIENT_MIGRATIONS);

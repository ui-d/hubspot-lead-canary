# Decisions and verified facts

Every external-API assumption in this repo is listed here with its verification date and source.
Re-verify before relying on anything older than ~3 months.

## Verified 2026-11-03

### Tooling

| Item               | Finding                                                                                                                                                                                                                                                                                                                  | Source                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Vitest integration | `@cloudflare/vitest-pool-workers` was renamed to `@cloudflare/vitest-plugin` (same API). Requires Vitest `^4.1 \|\| ^5`. Config: `cloudflareTest({ wrangler: { configPath } })` plugin in `defineConfig`.                                                                                                                | developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ |
| Test APIs          | `env`, `exports` (replaces `SELF`) come from `cloudflare:workers`. `createScheduledController`, `createExecutionContext`, `applyD1Migrations` from `cloudflare:test`. `readD1Migrations` is exported from `@cloudflare/vitest-plugin` root in v1.4.x (docs mention a `/config` subpath that this version does not ship). | test-apis docs + installed package `dist/pool/index.d.mts`                                              |
| `exports` typing   | `wrangler types` did not emit `GlobalProps.mainModule`; declared manually in `test/env.d.ts`.                                                                                                                                                                                                                            | local typecheck                                                                                         |
| Local cron trigger | `GET /cdn-cgi/local/scheduled?cron=...` (works with `wrangler dev`). Older `/__scheduled` is not documented anymore.                                                                                                                                                                                                     | developers.cloudflare.com/workers/configuration/cron-triggers/                                          |
| D1 config          | `d1_databases[]` keys: `binding`, `database_name`, `database_id`, `preview_database_id`, `migrations_dir`, `migrations_pattern`. `database_id` may be omitted locally (automatic provisioning creates it on deploy).                                                                                                     | developers.cloudflare.com/workers/wrangler/configuration/                                               |
| pnpm 11            | `minimumReleaseAge` is enforced by default. We do **not** add `minimumReleaseAgeExclude` entries; we let pnpm pick versions older than the age window (supply-chain safety). Build scripts allowed only for `esbuild`, `workerd`.                                                                                        | local install                                                                                           |
| Env typing         | `wrangler types --strict-vars false` (vars typed as `string`). Secrets declared in `src/env.ts`.                                                                                                                                                                                                                         | local                                                                                                   |

### HubSpot

| Item            | Finding                                                                                                                                                                                                                                                                                              | Source                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioning      | Since 2026-03-30 HubSpot REST APIs use date versions (`/YYYY-MM/`), new GA every March and September. Legacy v1–v4 paths remain supported, no sunset date published. **Decision:** CRM search, Owners, Properties use `2026-09`; paths centralised in `src/lib/hubspot-paths.ts`.                    | developers.hubspot.com/docs/developer-tooling/platform/versioning.md                                                                                                           |
| Owners          | `GET /crm/owners/2026-09/{ownerId}` by `id` (not `userId`). No `active` field: inactive = `archived: true`, `userId` null, `userIdIncludingInactive` set. Archived owners only returned with `archived=true`. Scope `crm.objects.owners.read`.                                                       | developers.hubspot.com/docs/api-reference/latest/crm/owners/guide.md                                                                                                           |
| Form submission | No date-versioned replacement. Use **unauthenticated** `POST https://api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}` so the canary behaves like a real website lead. Fields not on the form are rejected since 2022, so `leadcanary_is_test` must be a (hidden) form field. | developers.hubspot.com/docs/api-reference/legacy/marketing/forms/v3-legacy/submit-data-unauthenticated.md, changelog "validation change to the forms api submission endpoints" |
| Form creation   | Marketing Forms v3 (legacy) is the stable option; date-versioned forms API is only `2027-03-beta`.                                                                                                                                                                                                   | developers.hubspot.com/docs/llms.txt                                                                                                                                           |

### Sentry

| Item                 | Finding                                                                                                         | Source                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@sentry/cloudflare` | Needs `nodejs_compat` and `compatibility_date >= 2024-09-23`. Wrapper is applied only when `SENTRY_DSN` is set. | docs.sentry.io/platforms/javascript/guides/cloudflare/ |

### MCP endpoints

`https://docs.mcp.cloudflare.com/mcp`, `https://mcp.cloudflare.com/mcp` (Code Mode: `search` + `execute`, OAuth), `https://mcp.context7.com/mcp` (no API key in repo), `https://mcp.sentry.dev/mcp` (OAuth). Sources: developers.cloudflare.com/agents/model-context-protocol/, docs.sentry.io/ai/mcp/, context7.com/docs.

## Verified live 2026-11-20 (developer test portal, EU1 data centre)

First runs against a real portal. These replace docs-only assumptions above where they differ.

| Item              | Finding                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetch` redirects | The Workers runtime rejects `redirect: "error"` ("must be one of follow or manual"). The HubSpot client uses `redirect: "manual"`; a 3xx is returned as a non-retried failure. |
| Form creation     | `POST /marketing/v3/forms` returns `400 VALIDATION_ERROR` ("Some required fields were not set: [createdAt]") unless the body carries `createdAt` (we also send `updatedAt`).   |
| Form submission   | Unauthenticated `api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}` returns 200 for an EU1 portal; no region-specific host was needed.                   |
| Private apps      | New private apps are created under Development → Legacy Apps. HubSpot recommends Service Keys instead; the legacy app token works with the six scopes listed in the README.    |

## Design decisions

- **CHECK_FAILED verdict** (deviation from the original spec): an API/integration error during the check step is not the same as a lost lead. It gets its own verdict and counts toward incidents.
- **Repo root** is the project folder itself (no extra `hubspot-lead-canary/` subfolder).
- **Remote scripts** (`db:migrate:remote`, `deploy`) require typing `yes` interactively (`scripts/confirm.mjs`).

## Security review 2026-11-03 (security-reviewer over src/, scripts/, hooks)

Resolved:

- Alert email failure is no longer silent: incident gets a note and the run fails (Healthchecks `/fail`).
- `guard-secrets.sh` fails closed (ERR trap, jq presence check). Deny rules cover any Bash command touching `.dev.vars`.
- `SIMULATE` uses an allow-list of environments (`dev`, `demo`, `test`) instead of a production blacklist.
- Outside production the worker verifies the token's portal via `GET /account-info/2026-09/details`
  (`portalId` must equal `HUBSPOT_TEST_PORTAL_ID`, `accountType` must be `DEVELOPER_TEST`), using the real
  fetch even when a simulation replaces the CRM fetch. Verified endpoint in HubSpot public spec collection.
- HubSpot client is read-only by default: authenticated POSTs other than `/search` are refused unless
  `allowWrites` (setup script only). `redirect: "manual"` (changed from `"error"` on 2026-11-20, see above). Error categories allow-listed (`^[A-Z_]{1,40}$`).
- Empty `Retry-After` is treated as absent (found by probe tests).
- Check step refuses non-canary emails and only accepts search hits whose email equals the canary email.
- Run time budget of 4 minutes so runs never overlap the 5-minute cron.
- Error strings stored in D1 / sent to Healthchecks are masked (`maskText`) and capped at 200 chars.
- Sentry drops `fetch`/`http` breadcrumbs (ping URL is a secret), `sendDefaultPii: false`.
- `/report` adds `frame-ancestors`, `base-uri`, `form-action`, `referrer-policy`, `x-robots-tag`.
- Healthchecks ping requires `https:` and cannot throw on a malformed URL.
- gitleaks hook uses `gitleaks git --pre-commit --staged` and backs up a foreign hook.

Deferred (acceptable for the demo, required before a real client):

- `workers_dev` stays enabled so the demo has a URL; production must use a route and `workers_dev: false`.
- One global `ADMIN_TOKEN` for `/report`; move to per-client tokens and add a WAF rate limit on `/report`.
- No lease row against overlapping runs (the 4-minute budget mitigates it).
- No incident-alert retry flag (an alert failure is visible through the incident note and `/fail`).
- Production `HUBSPOT_TOKEN` must have read-only scopes only; form submission needs no token.

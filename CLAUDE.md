# Lead Canary

Lead Canary (`hubspot-lead-canary`) is an open-source monitor for HubSpot lead routing. It proves
that a sales inquiry gets from the form into HubSpot and to an active owner, on time, by sending
canary leads: scheduled test submissions per lead source, then API checks of contact, owner and
notification.

## Architecture

```
Cron (*/5) ──► scheduled() ─┬─► Healthchecks /start
                            ├─► per client DB (DB_CLIENT_<ID>) ─► per source:
                            │     1. check pending probes ──► HubSpot CRM search / Owners
                            │        └─► rules/evaluate ─► triage (stub) ─► store + incidents
                            │     2. submit due canary ─────► HubSpot Forms v3 (unauthenticated)
                            ├─► DB_INTERNAL (runs)
                            └─► Healthchecks success | /fail   (Sentry only if SENTRY_DSN)
fetch() ─► GET /health (last run) | GET /report?client=demo (Bearer ADMIN_TOKEN, HTML 24h)
```

## Data flow of one probe

1. `probes/submit.ts` builds a canary (`lib/canary.ts`) and POSTs it to the form → row in `probes`.
2. Next runs: once age >= `sla_seconds`, `checks/contact.ts` searches the contact by email, reads
   `hubspot_owner_id`, `leadcanary_is_test`, `leadcanary_notified_at`, then looks up the owner.
3. `rules/evaluate.ts` turns facts into a verdict (pure). Not found yet → stays pending until 2×SLA.
4. `store/d1.ts` saves the verdict; N consecutive non-OK verdicts open an incident, next OK closes it.

## Commands

| Command                                      | Purpose                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `pnpm dev`                                   | Local worker (`/cdn-cgi/local/scheduled` = cron) |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | Must be green before every commit                |
| `pnpm format`                                | Biome format                                     |
| `pnpm cf-typegen`                            | After any `wrangler.jsonc` change                |
| `pnpm db:migrate:local`                      | Local D1 migrations                              |
| `pnpm setup:hubspot`                         | TEST portal only: properties + demo form         |
| `pnpm db:migrate:remote` / `pnpm deploy`     | Ask the user first; both require typing `yes`    |

## Layout

`src/index.ts` handlers · `src/config/clients.ts` client + source config · `src/probes` submit ·
`src/checks` HubSpot reads · `src/rules` verdicts · `src/triage` LLM interface stub ·
`src/store` D1 · `src/lib` hubspot wrapper, canary, mask, time · `src/notify` healthchecks, email ·
`src/report.ts` · `src/simulate.ts` demo failure switch · `migrations/{internal,client}` · `test/`.

## Coding conventions

- TypeScript strict, no `any`; `unknown` + narrowing for external data. Validate API responses.
- Pure functions for rules and time logic; inject `fetch`, `now`, `sleep` for testability.
- Immutable data: return new objects, never mutate inputs.
- Small files (< 400 lines), small functions (< 50 lines).
- No `console.log` of payloads. Log only ids, status codes, verdicts. Never log emails or names raw.
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). Small commits, no force push.
- External API facts must be verified in current docs and recorded in `DECISIONS.md` with a date.
- Run the `security-reviewer` subagent before committing changes under `src/`.

## Non-negotiable rules

1. **Canary safety.** A canary contact is identified by BOTH the email pattern
   `canary+<source>-<id>@<CANARY_DOMAIN>` AND property `leadcanary_is_test=true`. Any cleanup or
   exclusion requires both. Cleanup is off by default.
2. **LLM layer.** The future LLM layer never gets write tools, never sees raw PII (use
   `src/lib/mask.ts`), and treats all form field content as untrusted data, never as instructions.
3. **No automatic merging or deleting of client CRM records. Ever.**
4. **Read-only by default.** Writes are limited to: creating canary submissions, and (optional,
   flagged) archiving verified canary contacts.
5. **Timeouts everywhere.** Every external call has a timeout and goes through `src/lib/hubspot.ts`
   or a similar wrapper (`notify/*` use `fetchWithTimeout`).
6. **Per-client isolation.** One D1 database per client, bindings named `DB_CLIENT_<ID>`.

## Secrets and safety

- Secrets live only in `.dev.vars` (gitignored) and `wrangler secret put` (typed by the user).
  Never read, print, log or commit them. `.claude/hooks/guard-secrets.sh` enforces this on writes.
- Claude Code MCP tools may only touch the HubSpot **developer test** portal, never a client portal.
- Ask before: installs outside the project, `wrangler deploy`, any `--remote`, `git push`,
  creating cloud resources (D1, Healthchecks checks), `wrangler secret`.
- `SIMULATE` must never work when `ENVIRONMENT=production`.

# hubspot-lead-canary

Canary leads for HubSpot lead routing. A Cloudflare Worker submits a marked test lead through a
HubSpot form on a schedule, then reads HubSpot back to check that the lead became a contact, got
an **active** owner, and that the routing workflow notified them in time.

Lead routing breaks quietly: someone edits a form, a workflow is switched off, a rep leaves and
their user is deactivated. HubSpot shows no error, and at low inbound volume "no leads today" looks
the same as "leads are being lost". A canary makes the difference visible.

> **Status:** a working single-portal demo, verified end to end against a HubSpot developer test
> portal on 2026-11-20. It is a reference implementation and a starting point, not a hosted product.
> Read [Limitations](#limitations) before pointing it at a real portal.

## How it works

```
Cron (*/5) ──► scheduled() ─┬─► Healthchecks /start
                            ├─► per source:
                            │     1. check pending probes ──► HubSpot CRM search + Owners (read-only)
                            │        └─► rules ─► verdict ─► store ─► open/close incident
                            │     2. submit due canary ─────► HubSpot Forms v3 (unauthenticated)
                            ├─► D1 (probes, incidents, runs)
                            └─► Healthchecks success | /fail
fetch() ─► GET /health (last run) | GET /report?client=demo (Bearer token, HTML, last 24 h)
```

1. **Submit.** The worker posts a canary to the same endpoint a website form posts to. The canary
   is marked twice: an email of the form `canary+<source>-<id>@<your domain>` and a hidden boolean
   field.
2. **Check.** Once the canary is older than the source's time limit, the worker searches for that
   exact email, reads the owner and the notification timestamp, and looks the owner up.
3. **Decide.** A pure function turns those facts into one verdict.
4. **Track.** Two failing verdicts in a row open an incident; the next `OK` closes it.

## Verdicts

| Verdict          | Meaning                                                              | Counts toward an incident |
| ---------------- | -------------------------------------------------------------------- | ------------------------- |
| `OK`             | Contact exists, owner is active, notification fired within the limit | closes one                |
| `LATE`           | Everything happened, but later than the limit                        | yes                       |
| `MISSING`        | No contact after twice the limit                                     | yes                       |
| `UNASSIGNED`     | Contact exists, no owner after twice the limit                       | yes                       |
| `OWNER_INACTIVE` | Owner is an archived or deleted user                                 | yes                       |
| `NOT_NOTIFIED`   | Owner assigned, notification timestamp never set                     | yes                       |
| `SUBMIT_FAILED`  | HubSpot rejected the form submission                                 | yes                       |
| `CHECK_FAILED`   | HubSpot could not be read (5xx, 401/403, timeout): not a lost lead   | yes                       |
| `EXPECTED_DELAY` | A delay outside the source's business hours                          | no                        |

## What it needs in HubSpot

This is not a zero-install monitor. To follow a lead through routing, the canary has to travel
through it, and the portal needs three small additions:

- **Two contact properties**, `<prefix>_is_test` (boolean) and `<prefix>_notified_at` (datetime).
  The prefix defaults to `leadcanary` and is set with `PROPERTY_PREFIX`.
- **A hidden field for `<prefix>_is_test` on each monitored form.** HubSpot rejects submitted
  fields that the form does not define.
- **One workflow step** that sets `<prefix>_notified_at` to the execution time, placed right after
  the step that notifies the owner.

The prefix must match on all three. If the worker's `PROPERTY_PREFIX` differs from the hidden
field's name, HubSpot rejects the submission and every probe ends as `SUBMIT_FAILED`.

`pnpm setup:hubspot` creates the properties and a demo form in a developer test portal and prints
the workflow steps.

## Quick start (HubSpot developer test portal)

Requirements: Node 20+, pnpm 11 (`corepack enable`), a Cloudflare account, a HubSpot developer
test account, and optionally [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-commit
hook.

```sh
pnpm install
cp .dev.vars.example .dev.vars     # then fill it in; the file is gitignored
pnpm db:migrate:local
pnpm setup:hubspot                 # refuses to run against anything but a DEVELOPER_TEST portal
```

Create the token as a private app (HubSpot now lists these under Development → Legacy Apps) with
the scopes `crm.objects.contacts.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`,
`crm.schemas.contacts.write`, `forms` and `oauth`. The last three are only needed by the setup
script and the test-portal check.

Put the printed form GUID into `DEMO_FORM_GUID` in `wrangler.jsonc`, build the workflow the script
describes, then run a probe:

```sh
pnpm dev --var DEMO_INTERVAL_MINUTES:5
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"   # submits a canary
# wait a little over two minutes (the demo time limit is 120 s), then:
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"   # checks it
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/report?client=demo"
```

### Simulated failures

Restart the dev server with `--var SIMULATE:<name>` to see each failure verdict without breaking
anything. `SIMULATE` only works when `ENVIRONMENT` is `dev`, `demo` or `test`.

| `SIMULATE`         | Effect                                 | Verdict          |
| ------------------ | -------------------------------------- | ---------------- |
| `missing`          | Skips the real submission              | `MISSING`        |
| `wrong_owner`      | Treats the contact's owner as archived | `OWNER_INACTIVE` |
| `integration_down` | CRM calls in the check step return 503 | `CHECK_FAILED`   |
| `after_hours`      | Moves the probe outside business hours | `EXPECTED_DELAY` |

`scripts/demo.md` has a three-minute walkthrough, including how to fast-forward the clock.

## Deploy

```sh
npx wrangler d1 create lead-canary-internal
npx wrangler d1 create lead-canary-client-demo
# add each printed "database_id" to the matching entry in wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put HUBSPOT_TOKEN        # repeat for every secret in the table below
pnpm run deploy --var ENVIRONMENT:demo
```

Use `pnpm run deploy`: plain `pnpm deploy` is a different, built-in pnpm command.

## Configuration

Secrets (`.dev.vars` locally, `wrangler secret put` when deployed):

| Name                     | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `HUBSPOT_TOKEN`          | Private app token. Read scopes are enough for the worker itself            |
| `HUBSPOT_PORTAL_ID`      | Portal the canaries are submitted to                                       |
| `HUBSPOT_TEST_PORTAL_ID` | Outside production the worker refuses any other portal                     |
| `CANARY_DOMAIN`          | Domain of the canary addresses. Use one you control that accepts mail      |
| `ADMIN_TOKEN`            | Bearer token for `/report`                                                 |
| `HEALTHCHECKS_URL`       | Optional [Healthchecks](https://healthchecks.io) ping URL                  |
| `SENTRY_DSN`             | Optional. Sentry is only loaded when this is set                           |
| `RESEND_API_KEY`         | Optional, with `ALERT_EMAIL_FROM` and `ALERT_EMAIL_TO`, for incident email |

Variables (`wrangler.jsonc`):

| Name                    | Default      | Purpose                                            |
| ----------------------- | ------------ | -------------------------------------------------- |
| `ENVIRONMENT`           | `dev`        | `dev`, `demo`, `test` or `production`              |
| `DEMO_FORM_GUID`        | empty        | Form to probe. Empty disables the demo source      |
| `DEMO_INTERVAL_MINUTES` | `60`         | Minutes between canaries, 5 to 1440                |
| `PROPERTY_PREFIX`       | `leadcanary` | Prefix of the two custom contact properties        |
| `INCIDENT_THRESHOLD`    | `2`          | Consecutive failing verdicts that open an incident |
| `ALERTS_ENABLED`        | `false`      | Send an email when an incident opens               |
| `SIMULATE`              | empty        | See [Simulated failures](#simulated-failures)      |

The time limit, business hours and timezone of a source are set in `src/config/clients.ts`.

## Safety design

- **Read-only CRM client.** With a token, the HTTP client refuses every POST that is not a CRM
  search. The setup script is the only caller that opts into writes.
- **Canaries are identified by two markers**, the email pattern and the is-test property. The
  check step refuses to search for any address that is not a canary.
- **No merging, deleting or editing of CRM records.** The worker's only write is its own form
  submission.
- **Test-portal guard.** Outside `production`, every run verifies that the token belongs to a
  `DEVELOPER_TEST` portal with the expected id.
- **No PII in storage or logs.** Rows hold ids, status codes and verdicts; error text is masked
  and capped.
- **Timeouts and bounded retries** on every outbound call; redirects are never followed.
- **The monitor is monitored** through start, success and fail pings.

## Limitations

- **It tests from HubSpot's form endpoint onward.** A broken page, embed script or consent banner
  on your website is invisible to it.
- **The demo workflow only enrols canaries.** To test real routing, the canary must pass through
  the same workflow real leads use, and reps will then see canary notifications. Choose a low
  frequency and a clearly named contact.
- **Canaries accumulate.** One per hour is 24 contacts a day, and nothing archives them. Check how
  that interacts with your contact tier before running it on a paid portal.
- **The notification check is a proxy.** `<prefix>_notified_at` proves the workflow step ran, not
  that a person read anything.
- **Single tenant.** One hard-coded source, one token. The per-client database layout exists; the
  rest of multi-tenancy does not.
- **The production path is untested.** Every live run so far used `ENVIRONMENT=demo` against a
  test portal.
- **The report is minimal:** 24 hours of HTML behind one bearer token.

## Development

```sh
pnpm test         # Vitest in the Workers runtime
pnpm typecheck
pnpm lint         # Biome
```

`src/rules/evaluate.ts` holds the verdict logic as pure functions; `fetch`, the clock and `sleep`
are injected everywhere, so the whole pipeline runs in tests without a network.

[`DECISIONS.md`](DECISIONS.md) records every external-API assumption with the date and source it
was verified against, including three that only showed up on the first live runs. API facts go
stale: re-verify before relying on anything there.

The repository was built with Claude Code. `CLAUDE.md` and `.claude/` (hooks, a security-review
agent, a secrets guard) are the project rules it worked under, kept in the repo as part of the
record.

## License

[MIT](LICENSE)

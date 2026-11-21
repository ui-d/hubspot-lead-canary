---
name: new-client
description: Checklist to onboard a new Lead Canary client (D1 database, binding, migrations, secrets, lead sources, canary marking agreement, SLA, business hours, Healthchecks, dry run, first report). Use when the user says they are adding or onboarding a client.
---

# Onboard a new Lead Canary client

Work through the steps in order. Stop and ask the user before every step marked **[ASK]**
(remote resources, secrets, client communication). Never touch a client HubSpot portal with
Claude Code MCP tools.

## 1. Inputs to collect from the user

- Client id (lowercase, `[a-z0-9]+`, used in `DB_CLIENT_<ID>`), display name, timezone (IANA).
- Lead sources: HubSpot portal id, form GUID(s), expected SLA (seconds), probe interval
  (minutes), business hours per source (days, start, end, timezone).
- Who receives alerts; whether incidents notify the client or only Lead Canary.

## 2. Agreement with the client (the user handles this)

- Canary identity: `canary+<source>-<id>@<CANARY_DOMAIN>` AND `leadcanary_is_test=true`.
- Client adds `leadcanary_is_test` as a hidden field on each monitored form.
- Client excludes canaries from workflows that must not see them (sequences, scoring,
  reporting, ad audiences), using BOTH markers.
- Client lets the routing workflow set `leadcanary_notified_at` (or agrees another signal).
- Private app token: read-only scopes (`crm.objects.contacts.read`, `crm.objects.owners.read`).
- Cleanup of canaries stays off unless explicitly agreed in writing.

## 3. Infrastructure

1. **[ASK]** `npx wrangler d1 create lead-canary-client-<id>`.
2. Add a binding `DB_CLIENT_<ID>` to `wrangler.jsonc` (`migrations_dir: migrations/client`), then `pnpm cf-typegen`.
3. `npx wrangler d1 migrations apply lead-canary-client-<id> --local`; **[ASK]** the same with `--remote`.
4. **[ASK]** User runs `npx wrangler secret put HUBSPOT_TOKEN_<ID>` and types the value.
5. Add client and sources to `src/config/clients.ts`; insert the `clients` row in `DB_INTERNAL`.
6. **[ASK]** Create a Healthchecks check (period 5 min, grace 10 min) and store its URL as a secret.

## 4. Verify

1. `pnpm test && pnpm typecheck && pnpm lint`.
2. Dry run locally with `SIMULATE` empty: trigger `/cdn-cgi/local/scheduled`, confirm one probe
   is submitted and checked with verdict OK.
3. **[ASK]** Deploy. Watch the first 3 runs and the Healthchecks dashboard.
4. Open `/report?client=<id>` and share a summary with the user (not with the client).

## 5. Record

Add a dated line to `DECISIONS.md`: client id, sources, SLA, business hours, agreed markers.

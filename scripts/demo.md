# Lead Canary demo: 3-minute video runbook

Audience: founder or RevOps lead at a small B2B SaaS company on HubSpot.
Goal: show that Lead Canary catches broken lead routing before a real lead is lost, and does not
cry wolf after hours.

## Before recording (not on camera)

1. `.dev.vars` filled in (test portal token, portal ids, canary domain, Healthchecks URL, admin token).
2. `pnpm setup:hubspot` done, `DEMO_FORM_GUID` set in `wrangler.jsonc`, workflow in the test
   portal is ON (rotate owner Test Rep A/B → set `leadcanary_notified_at`).
3. `pnpm db:migrate:local`, then start `pnpm dev --var DEMO_INTERVAL_MINUTES:5` in terminal 1
   (the default is one canary per hour so the deployed demo does not flood the test portal).
4. Pre-run each scenario once so the report already has history (see "Fast-forward" below).
5. Browser tabs: HubSpot test portal (contacts list filtered on Lead Canary test lead = Yes),
   `http://localhost:8787/report?client=demo` (use a header extension or curl to show it),
   Healthchecks dashboard.

### Fast-forward (no waiting for the SLA)

The scheduled handler uses the cron's `scheduledTime`, and local triggers accept `time`:

```sh
T0=$(date +%s000)
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*&time=$T0"                 # submit
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*&time=$((T0+150000))"       # check after SLA (120 s)
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*&time=$((T0+300000))"       # next probe due
```

Simulations: stop `pnpm dev`, restart with
`pnpm dev --var DEMO_INTERVAL_MINUTES:5 --var SIMULATE:missing` (or `wrong_owner`,
`integration_down`, `after_hours`). Leave about 40 real seconds between a submit run and its
check run: the fast-forwarded clock does not speed up the HubSpot workflow. Never possible with `ENVIRONMENT=production`.

## Script (≈ 3:00)

### 0:00–0:25 The problem

"Every inbound demo request should land in HubSpot and reach the right rep within minutes.
When a form, a workflow or a rep's account changes, routing breaks silently. Nobody notices
until a prospect complains or a quarter looks thin. Lead Canary tests the route continuously,
the way uptime monitoring tests a website."

### 0:25–1:05 A live OK probe

1. Trigger a run. "Lead Canary submits a canary lead through the real form. It is marked twice:
   a `canary+…` email and a hidden `leadcanary_is_test` flag, so it can always be excluded."
2. Show the contact appearing in HubSpot with an owner and `Lead Canary notified at` set.
3. Trigger the check run. Show `/report`: verdict **OK**, latency in seconds.
   "It checks three things over the API: the contact exists, it has an active owner, and the
   notification fired within the SLA."

### 1:05–2:10 Three failures

1. **MISSING** (`SIMULATE=missing`): "Here the form silently stopped creating contacts.
   After twice the SLA, Lead Canary says MISSING. Two in a row open an incident."
2. **OWNER_INACTIVE** (`SIMULATE=wrong_owner`): "The lead was assigned to a rep who has been
   deactivated. HubSpot shows an owner; nobody will ever call. Lead Canary flags it immediately."
3. **CHECK_FAILED** (`SIMULATE=integration_down`): "HubSpot's API is failing. Lead Canary reports
   an integration problem instead of pretending leads are lost, so you fix the right thing."

### 2:10–2:35 The legitimate exception

**EXPECTED_DELAY** (`SIMULATE=after_hours`): "This lead came in at night. The team routes in
the morning, so missing notification within the SLA is expected. Lead Canary records it, but no
incident and no alert. Business hours are configured per source and timezone."

### 2:35–3:00 The report and the safety net

Show `/report`: verdict counts, open incidents, median latency, probe table. Show
Healthchecks: "If Lead Canary itself stops running, we get paged too." Close: "Read-only access,
canaries clearly marked, no client records ever merged or deleted."

## Sample diagnosis report outline (sent by Lead Canary to a client after an incident)

1. **Summary**: one sentence, what broke and since when (client timezone).
2. **Impact window**: first failing probe → first OK probe; which source/form.
3. **Evidence**: probe timeline table (time, verdict, HTTP status codes, latency).
4. **Probable cause**: with confidence (low/medium/high) and what would confirm it.
5. **Recommended fix**: concrete steps in HubSpot (workflow, form, user settings).
6. **Leads to review**: how to find real contacts created in the window (HubSpot filter);
   Lead Canary does not read or change them.
7. **Follow-up**: when the next probes run and how the client will know it is resolved.

No revenue estimates unless the client provides their own numbers.

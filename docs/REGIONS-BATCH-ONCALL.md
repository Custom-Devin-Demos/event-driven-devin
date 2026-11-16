# Regions Enterprise Batch Control

Native skin: `/oncall/c/db10f6b2` (also `/regions-batch-oncall`). Separate from Regions online banking skin `5e57909d`.
Remediation repository: **COG-GTM/rg-oncall**, branch `main`.

## Setup

PagerDuty account: `humza-cog`. Services: Axway MFT Gateway **PU8BL8X**, EDW SQL Load **PQZQKW7**, Mainframe Batch zOS **PN02JGH**.
The server sends Events API v2 triggers MFT → SQL → MAINFRAME, 30 seconds apart. Payloads preserve the settlement evidence pointers in rg-oncall. Every event includes its UUID `run_id` in custom details and dedup key.

Set these on the app host (never in browser code):

| Variable | Purpose |
| --- | --- |
| `BATCH_PD_ROUTING_KEY_MFT`, `BATCH_PD_ROUTING_KEY_SQL`, `BATCH_PD_ROUTING_KEY_MF` | Events v2 integration keys; each 32 alphanumeric characters |
| `BATCH_PD_API_TOKEN` | PagerDuty REST token for alerts, incidents and notes; 20–64 alphanumeric/underscore/plus/hyphen characters |
| `BATCH_PD_WEBHOOK_SECRET` | Custom-header shared secret; 16–128 alphanumeric/underscore/hyphen characters |
| `BATCH_PD_MFT_SERVICE_ID` | Defaults to `PU8BL8X`; must match the MFT integration key's service |
| `BATCH_PD_DRY_RUN` | `1` logs component names only and sends no events. Missing/invalid routing keys also force dry run. Set explicitly to `0` for a live run |
| `BATCH_PD_DELAY_SECONDS` | Default 30; allowed range 0–3600 |

The five secret variables above may be set as identically named GitHub Actions secrets; deploy stages them into EC2 `/home/ubuntu/.env` under the deploy lock with strict validators. Alternatively an authorized host operator can set them there. Compose imports the entire file; recreate the app container to load changes. Nonsecret settings are host `.env` settings, not Actions-synchronized variables. No Compose edits are required.

Repoint PagerDuty v3 subscription **P6KXU5L** to:

`https://devindemos.com/api/oncall/batchsettlement/pagerduty-webhook`

Configure its custom header `X-Webhook-Secret` to exactly match `BATCH_PD_WEBHOOK_SECRET`. Missing configuration or an incorrect header returns 401. Subscribe to `incident.triggered`; only the MFT service dispatches. The v3 shape is `{ event: { event_type: 'incident.triggered', data: { id, service: { id }, ... } } }`; it normally has no alert details. The adapter fetches `GET /incidents/<id>/alerts?limit=1` and reads the first alert's `body.details.run_id`. Unknown/reset runs return 202 without dispatch. PagerDuty reference: https://developer.pagerduty.com/docs/889a488d6b0d3-webhooks-v3-overview .

The native `postOncallAlert` path posts in **C0BNWUGCWBS / #oncall-alerts** using `SLACK_ONCALL_BOT_TOKEN` (or `SLACK_BOT_TOKEN`), independently of the shared channel setting. On-call falls back to **U0BQZBHCNMA**; a resolvable presenter email takes precedence. The incident URL appears in the card and session prompt. The API receives the presenter's stored `devinOrgId` / `devinUserId`; configure `DEVIN_ONCALL_SERVICE_KEY` with authorization for that org. Without a complete presenter pair, standard on-call org/user environment fallbacks apply.

Separately configure the target **Devin organization** (humza-org) with `PAGERDUTY_API_TOKEN`, Slack posting tools or `SLACK_ONCALL_BOT_TOKEN` / `COG_GTM_DEMO_SLACK_BOT_TOKEN`, and GitHub write access to `COG-GTM/rg-oncall`. App environment secrets are NOT forwarded into sessions. Disable any channel automation that would independently investigate this card, to avoid duplicate sessions.

## Run sheet

1. Set presenter identity on the demo hub in the same browser. Open Batch Control; confirm all ten jobs are scheduled and incident feed empty after reset.
2. Confirm the mode band: **DRY RUN** is safe; **LIVE EVENTS** sends real incidents. In dry run the events are suppressed, but an authenticated webhook for a known run can still invoke Slack/Devin; stub those dependencies during local webhook tests.
3. Press **Run overnight settlement** once. A second request while the three-event dispatcher is active returns 409. Run/reset share a dedicated on-call batch settlement IP cap (50/hour).
4. MFT arrives first. Its webhook reserves the run and posts one Slack alert with a new Devin session and PagerDuty incident link. The browser does not call the generic shim trigger. Duplicate/concurrent webhook deliveries return 200; failed dispatches release the reservation for retry. The console links to Devin after session creation.
5. Watch SQL then mainframe incidents appear. Devin waits about 90 seconds, correlates the run, posts PagerDuty notes and a Slack-thread HOLD table, then opens a tested fix PR. PR links produce **Fix PR open** badges only. Notes are rendered as text, not HTML.
6. Red = failing service's jobs; amber = explicit HOLD/not-resubmit. Only an explicit job-specific COMPLETE/RELEASED directive makes green. Latest directive wins. Human approval is required to merge and release holds; Devin never merges or resolves incidents.

## Reset and operational limits

`POST /api/oncall/batchsettlement/reset` cancels future unsent events, clears local runs/session links/dedup/cache and advances the incident scope. It never modifies PagerDuty or cancels an already running Devin session. Events already in flight cannot be recalled. State shows only unresolved incidents created strictly after reset or server start; it does not restrict the feed to just the most recent run. Poll cache is five seconds.

All state and dedup reservations are in-process, matching the single-instance console. Restart loses run correlation, so old webhook deliveries are ignored; reset between demonstrations. Do not horizontally scale without shared run/dedup storage. Up to 1000 runs can be retained between resets. An active run means its three-event dispatcher is running, not that responders have finished. Each distinct known run bypasses the generic alert time-window grouping, but global session caps/API failures still apply. A failed Slack/session attempt returns 503 for webhook retry (an earlier card can remain if session creation failed).

## Local verification

Start without outbound credentials: `BATCH_PD_DRY_RUN=1 PORT=3100 node app/server.js`. The page still renders inventory when the REST token is absent, with a polling-disabled warning. Test webhooks using an injected stub `postAlert` in the test suite, not live credentials.

`npx jest --runInBand tests/regions-batch-oncall.test.js tests/5e57909d-oncall-skin.test.js tests/oncall-skin-*.test.js`

`npm run lint`

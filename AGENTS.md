# AGENTS.md — Guide for AI Software Engineering Agents

This document describes the **Event-Driven Devin** demo repository for AI agents that are asked to investigate, fix, or extend the codebase.

## What This Repo Is

A Node.js/Express application with integrated observability (Sentry + Datadog) and automated incident response (Slack alerts + Devin). The app serves **10 industry vertical demos**, each with its own frontend, API routes, and business logic. Each vertical has a production bug that produces a `TypeError` when its primary action is triggered. When an error occurs, the system automatically posts an alert to Slack and triggers a Devin session to investigate and fix it.

## Industry Verticals

The app hosts 10 verticals, each accessible at its own URL:

| Vertical | URL Path | Frontend | API Endpoint | Service File |
|----------|----------|----------|--------------|-------------|
| **Hub** (landing page) | `/` | `app/public/hub.html` | — | — |
| **Retail eCommerce** | `/retail` | `app/public/index.html` | `POST /api/storefront/checkout` | `app/routes/storefront.js` |
| **Banking** | `/banking` | `app/public/verticals/banking.html` | `POST /api/banking/transfer` | `app/services/verticals/banking.js` |
| **Financial Services** | `/financial-services` | `app/public/verticals/financial-services.html` | `POST /api/trading/execute` | `app/services/verticals/financial-services.js` |
| **Insurance** | `/insurance` | `app/public/verticals/insurance.html` | `POST /api/insurance/claim` | `app/services/verticals/insurance.js` |
| **CPG** | `/cpg` | `app/public/verticals/cpg.html` | `POST /api/cpg/order` | `app/services/verticals/cpg.js` |
| **High Tech** | `/hightech` | `app/public/verticals/hightech.html` | `POST /api/licenses/provision` | `app/services/verticals/hightech.js` |
| **Industrials** | `/industrials` | `app/public/verticals/industrials.html` | `POST /api/maintenance/workorder` | `app/services/verticals/industrials.js` |
| **Healthcare** | `/healthcare` | `app/public/verticals/healthcare.html` | `POST /api/healthcare/appointment` | `app/services/verticals/healthcare.js` |
| **Telco** | `/telco` | `app/public/verticals/telco.html` | `POST /api/telco/upgrade` | `app/services/verticals/telco.js` |
| **Payer** (unlisted — direct URL only) | `/payer`, `/welcome-season` | `app/public/verticals/payer.html` | `POST /api/payer/pharmacy-claim` | `app/services/verticals/payer.js` |
| **CommBank NetBank** (unlisted — direct URL only) | `/cba` | `app/public/verticals/cba.html` | `POST /api/banking/transfer` (shared with Banking) | `app/services/verticals/banking.js` |

Each vertical follows the same flow: **User action → Bug triggers → Sentry/Datadog capture → Slack alert → Devin investigates → PR created**.

### On-call vertical slice (Flows 1–2)

Separate from the legacy verticals above, the On-Call demo (`/oncall`) serves the same branded pages in on-call mode with their primary action rerouted (via an injected fetch shim in `app/routes/oncall.js`) to a parallel set of endpoints backed by copied services carrying performance-degradation bugs instead of TypeErrors:

| Vertical | On-call API Endpoint | Service File |
|----------|---------------------|--------------|
| Banking | `POST /api/oncall/banking/transfer` | `app/services/oncall-verticals/banking.js` |
| Telco | `POST /api/oncall/telco/upgrade` | `app/services/oncall-verticals/telco.js` |
| High Tech | `POST /api/oncall/licenses/provision` | `app/services/oncall-verticals/hightech.js` |
| Insurance | `POST /api/oncall/insurance/claim` | `app/services/oncall-verticals/insurance.js` |
| Industrials | `POST /api/oncall/industrials/quote` | `app/services/oncall-verticals/industrials.js` |
| Voice | `POST /api/oncall/voice/transcribe` | `app/services/oncall-verticals/voice.js` |

Routes are mounted from `app/routes/oncall-verticals.js`. The degradations are deliberately not described here — the on-call demo's premise is that the responder diagnoses them from telemetry. The legacy `/api/<vertical>/...` endpoints and their planted TypeErrors are untouched.

Customer skins receive the alerts surface by default. Optional `bugPortal` and `incident` skin config entries opt into `/oncall/c/:slug/report` and `/oncall/c/:slug/incident` respectively.

### Payer welcome-season scenario

The payer vertical models a plan-configuration defect rather than an infrastructure failure: `PLAN_CONFIGS` carries a 7-digit `rxBin` (`0044336` instead of `004336`) for two plans, `generateMemberIdCard()` copies it onto member ID cards unvalidated, and `adjudicateClaim()` then finds no `PAYER_REGISTRY` entry for that BIN. Every service stays healthy — the only signal is the `pharmacy_claim.rejected` business metric.

The page is not registered in the `VERTICALS` array in `app/routes/verticals/index.js`, so it does not appear on the hub: it is plan-branded and the hub is on screen during customer demos. Reach it at `/welcome-season`.

Two things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live (add routing validation before a card is issued). Set both NC State Health Plan `rxBin` values to `004336` to run the demo pre-fixed.
- **`scripts/welcome-season-sweep.js` is the prevention control** — it validates every Jan-1 plan config and submits synthetic claims, exiting non-zero before cards mail. It owns its own `validateRxRouting()` because the service intentionally has none yet.

`FANOUT_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`, instructing the triage session to split remediation across four parallel child sessions. See `docs/DEMO-WELCOME-SEASON.md` for the run sheet and `docs/WIKI-PAYER-WELCOME-SEASON.md` for the full reference.

### Kroger feature-encoding scenario

The Kroger vertical (`/kroger`, slug `eaa595e1`) plants **one encoding gap with two symptoms**, aimed at a data-science audience. The annual-billing rollout added a `boost-annual` tier mapped to the `boost_annual` program code, but that code was never registered in two separate places:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `computeFuelPoints()` | Dereferences the missing `FUEL_POINT_PROGRAMS` entry and throws | `TypeError` → Sentry → Slack → Devin session |
| `rankOffers()` | Finds no vector in the offer-affinity feature view, scores every offer 0, serves the unranked pool | HTTP 200. Only `personalization.offer_match_rate` dropping to 0 |

The silent half is the point: models do not crash when they break, they quietly get worse.

**The defect originates in the pipeline, not the route.** `pipelines/kroger/offer-affinity-spec.json` is the source of truth for segment encoding; `pipelines/kroger/build-offer-features.js` materializes it into `app/services/verticals/features/eaa595e1-offer-affinity.json`, which the service loads at require time. A tier declared in `membershipTiers` with no entry under `segments` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add a `boost_annual` segment to the spec, run `npm run features:build`, and add a `boost_annual` entry to `FUEL_POINT_PROGRAMS`. The service `require`s the built artifact, so Node caches it at startup — **restart the server after a rebuild**, or the storefront keeps serving the degraded state.
- **`scripts/kroger-personalization-audit.js` is the prevention control** (`npm run audit:kroger`) — it scores every tier the *service* can serve through the real ranker and exits non-zero when a tier is undeclared in the spec, mapped inconsistently between spec and service, absent from the feature view, or encoded but scoring nothing. It is not wired into the build, which is why the gap reached production.
- **`npm run features:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte, so a hand-edited artifact does not pass.

`SECOND_ORDER_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`. It sends the session to the audit first, then to the spec and the build's missing coverage gate — explicitly instructing it to fix the data problem rather than patch the crash site. Regression coverage for both paths lives in `tests/kroger-offer-affinity.test.js`.

### Gap style-encoding scenario

The Gap data-intelligence vertical (`/gapdata`, slug `383b99d1`) plants **one encoding gap with two symptoms**, aimed at a data-intelligence audience. It is separate from the original Gap checkout vertical (`/43f2f084`), which keeps its receipt-formatting TypeError. The Good Rewards relaunch added an `icon` tier mapped to the `gr_icon` program code, but that code was never registered in two separate places:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `computeRewardsPoints()` | Dereferences the missing `REWARDS_POINT_PROGRAMS` entry and throws | `TypeError` → Sentry → Slack → Devin session |
| `rankOffers()` | Finds no vector in the style-affinity feature view, scores every offer 0, serves the unranked pool | HTTP 200. Only `personalization.offer_match_rate` dropping to 0 |

**The defect originates in the pipeline, not the route.** `pipelines/gap/style-affinity-spec.json` is the source of truth for segment encoding; `pipelines/gap/build-style-features.js` materializes it into `app/services/verticals/features/383b99d1-style-affinity.json`, which the service loads at require time. A tier declared in `membershipTiers` with no entry under `segments` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add a `gr_icon` segment to the spec, run `npm run style:build`, and add a `gr_icon` entry to `REWARDS_POINT_PROGRAMS`. The service `require`s the built artifact, so **restart the server after a rebuild**.
- **`scripts/gap-personalization-audit.js` is the prevention control** (`npm run audit:gap`) — it scores every tier the *service* can serve through the real ranker and exits non-zero when a tier is undeclared in the spec, mapped inconsistently between spec and service, absent from the feature view, or encoded but scoring nothing. It is not wired into the build, which is why the gap reached production.
- **`npm run style:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte.

`SECOND_ORDER_DIRECTIVE` in `app/services/verticals/383b99d1.js` is appended to the Devin prompt via `alertData.promptAppendix`, sending the session to the audit first, then to the spec and the build's missing coverage gate. Regression coverage for both paths lives in `tests/gap-style-affinity.test.js`.

### S&P Global feed-migration parity scenario

The S&P Global Market Intelligence vertical (`/spglobal`, slug `da6578ee`) plants **one field-mapping gap with two symptoms**, aimed at a data-platform audience mid-migration from legacy feed handlers onto a Databricks/Delta lakehouse. Wave 3 onboarded a `depositary_receipt` instrument class mapped to the `equity_adr` contract code, but that code was never given a contract:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `normalizeMigratedRow()` | Dereferences the missing contract's `priceScale` and throws | `TypeError` → Sentry → Slack → Devin session |
| `runParityCheck()` | Cannot normalize those rows, so it holds them out of the comparison population and divides matches by what is left | HTTP 200 reporting `parity_match_rate = 1.0`. Only `feed.parity_coverage` sits below 1.0 |

The silent half is the point: a migration that reports 100% parity on a population it silently narrowed is worse than one that reports a failure — the excluded class never lands in Delta.

**The defect originates in the pipeline, not the route.** `pipelines/spgi/feed-mapping-spec.json` is the source of truth for instrument-class mapping; `pipelines/spgi/build-feed-contract.js` materializes it into `app/services/verticals/features/da6578ee-feed-contract.json`, which the service loads at require time. A class declared in `instrumentClasses` with no entry under `contracts` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add an `equity_adr` contract to the spec and run `npm run feed:build`. The service `require`s the built artifact, so **restart the server after a rebuild**.
- **`scripts/spgi-parity-audit.js` is the prevention control** (`npm run audit:spgi`) — it drives every instrument class the *service* can publish through the real parity harness and exits non-zero when a class is undeclared in the spec, mapped inconsistently between spec and service, absent from the contract, or contributing no compared rows. It is not wired into the build, which is why the gap reached production.
- **`npm run feed:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte.

`PARITY_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`. It sends the session to the audit first, then to the spec, the build's missing coverage gate, and the harness's fail-open exclusion logic. Regression coverage for both paths lives in `tests/spgi-feed-parity.test.js`.

## Repository Structure

```
├── app/
│   ├── server.js                  # Express app entry point (mounts all vertical routes)
│   ├── incidentModes.js           # Scenario state management (healthy, checkout-regression, etc.)
│   ├── public/
│   │   ├── hub.html               # Landing page with cards for the 9 listed verticals (payer is unlisted)
│   │   ├── index.html             # Retail eCommerce storefront UI
│   │   ├── automations.html       # Slow-query patrol explainer and Run Now control
│   │   ├── oncall-report.html     # Shared customer-skinned support portal
│   │   ├── oncall-incident.html   # Shared customer-skinned SEV-1 incident console
│   │   └── verticals/
│   │       ├── banking.html       # Apex Bank — Online Banking
│   │       ├── financial-services.html  # Meridian Capital — Trading Platform
│   │       ├── insurance.html     # Shield Insurance — Claims Portal
│   │       ├── cpg.html           # Harvest Goods — Distributor Orders
│   │       ├── hightech.html      # NovaSoft — SaaS License Management
│   │       ├── industrials.html   # Titan Mfg — Equipment Maintenance
│   │       ├── industrials-quote.html # Titan Mfg — Instant Quote
│   │       ├── 08d969be.html       # Native industrials customer skin
│   │       ├── voice.html         # EchoScribe — Dictation Console (on-call only)
│   │       ├── 2acc11fd.html       # Native voice customer skin
│   │       ├── healthcare.html    # CarePoint — Patient Portal
│   │       ├── telco.html         # WaveConnect — Telecom Self-Service
│   │       └── payer.html         # Payer — Member ID card + pharmacy counter
│   ├── routes/
│   │   ├── storefront.js          # Retail: product catalog + checkout
│   │   ├── verticals/
│   │   │   ├── index.js           # Mounts all vertical route files
│   │   │   ├── banking.js         # Banking: accounts + transfer
│   │   │   ├── financial-services.js  # Financial Services: portfolio + trade
│   │   │   ├── insurance.js       # Insurance: policies + claims
│   │   │   ├── cpg.js             # CPG: catalog + bulk orders
│   │   │   ├── hightech.js        # High Tech: subscriptions + license provisioning
│   │   │   ├── industrials.js     # Industrials: equipment + work orders
│   │   │   ├── healthcare.js      # Healthcare: providers + appointments
│   │   │   ├── telco.js           # Telco: plans + upgrades
│   │   │   └── payer.js           # Payer: ID cards + pharmacy claims
│   │   ├── oncall.js              # On-Call demo pages, alert/bug triggers, skinned routes
│   │   ├── oncall-verticals.js    # On-call vertical slice endpoints (/api/oncall/<vertical>/...)
│   │   ├── internal-jobs.js       # Slow-query patrol jobs (container-network-only; nginx returns 404)
│   │   ├── automations.js         # Automations explainer page and Run Now Devin session endpoint
│   │   ├── checkout.js            # Legacy checkout endpoint
│   │   ├── sentry-webhook.js      # Receives Sentry alert webhooks, triggers Devin via Slack
│   │   ├── webhook.js             # GitHub webhook handler
│   │   ├── health.js              # Health check endpoint
│   │   ├── login.js               # Auth endpoint
│   │   ├── search.js              # Product search
│   │   ├── orders.js              # Order lookup
│   │   └── admin.js               # Scenario management (GET/POST /admin/scenario)
│   ├── services/
│   │   ├── devin-session.js       # Builds investigation prompt, posts Slack alert, triggers Devin
│   │   ├── slack.js               # Slack API helpers (post messages, thread replies, delete messages)
│   │   ├── verticals/
│   │   │   ├── banking.js         # Banking business logic
│   │   │   ├── financial-services.js  # Trading business logic
│   │   │   ├── insurance.js       # Claims business logic
│   │   │   ├── cpg.js             # CPG order business logic
│   │   │   ├── hightech.js        # License provisioning business logic
│   │   │   ├── industrials.js     # Maintenance work order business logic
│   │   │   ├── healthcare.js      # Appointment scheduling business logic
│   │   │   ├── telco.js           # Plan upgrade business logic
│   │   │   ├── payer.js           # Pharmacy claim adjudication business logic
│   │   │   └── features/
│   │   │       └── eaa595e1-offer-affinity.json  # Built Kroger feature view (generated — do not hand-edit)
│   │   ├── oncall.js              # On-Call alert/bug-report cards, scenarios, incident state
│   │   ├── oncall-verticals/      # Copied vertical services for the on-call slice
│   │   │   ├── banking.js         # On-call banking business logic
│   │   │   ├── telco.js           # On-call telco business logic
│   │   │   ├── hightech.js        # On-call license provisioning business logic
│   │   │   ├── insurance.js        # On-call claims business logic
│   │   │   ├── industrials.js      # On-call instant quote business logic
│   │   │   ├── industrials-edge.js # On-call mTLS edge gateway, rotation, and certificate material
│   │   │   └── voice.js           # On-call dictation transcript business logic
│   │   ├── checkout.js            # Checkout business logic (includes scenario-based bugs)
│   │   ├── github-webhook.js      # GitHub webhook processing
│   │   ├── auth.js                # Auth service
│   │   ├── orders.js              # Order service
│   │   └── search.js              # Search service
│   └── telemetry/
│       ├── datadog.js             # Datadog APM + custom metrics init
│       ├── sentry.js              # Sentry SDK init
│       └── logger.js              # Winston structured JSON logger
├── loadgen/
│   └── worker.js                  # Synthetic traffic generator (search, login, orders — NOT checkout)
├── scripts/
│   ├── setup-datadog-dashboard.js # Creates Datadog dashboard via API
│   ├── setup-sentry-alerts.js     # Creates Sentry alert rules via API
│   ├── patrol-digest.js           # Formats validated Slow Query Patrol Slack digests
│   ├── patrol-before-after.js     # Compares pre-fix and fixed patrol job responses
│   ├── trigger.js                 # Manually trigger error scenarios
│   ├── warmup.js                  # Pre-warm the app
│   ├── welcome-season-sweep.js    # Validates Jan-1 plan card configs before cards mail (exits 1 on defect)
│   ├── kroger-personalization-audit.js  # Scores every membership tier through the ranker (exits 1 on an unencoded segment)
│   ├── spgi-parity-audit.js       # Drives every instrument class through the parity harness (exits 1 on an uncovered class)
│   ├── reset.js                   # Reset scenario to healthy
│   └── cleanup.js                 # Clean up resources
├── pipelines/
│   ├── kroger/
│   │   ├── offer-affinity-spec.json     # Source of truth for Kroger segment encoding
│   │   └── build-offer-features.js      # Materializes the spec into the served feature view
│   └── spgi/
│       ├── feed-mapping-spec.json       # Source of truth for SPGI instrument-class field mapping
│       └── build-feed-contract.js       # Materializes the spec into the served feed contract
├── config/
│   └── scenarios.json             # Scenario definitions
├── tests/
│   ├── ...                         # Vertical, pipeline, and integration test suites
│   ├── internal-jobs.test.js      # Slow-query patrol telemetry and ranking tests
│   └── automations.test.js        # Automations page and Run Now endpoint tests
├── docs/
│   ├── ...                         # Demo runbooks and scenario documentation
│   ├── patrol-evidence-chart.template.html # Shared evidence chart template for the daily patrol
│   └── slow-query-patrol-backlog.md # Slow-query patrol jobs, cadence, and telemetry contract
├── prompts/
│   ├── automations-patrol-backtest.md # Mode delta for presenter backtests
│   └── automations-patrol-production.md # Mirrors the scheduled automation's stored prompt; not loaded by code
├── docker-compose.yml             # 3 services: checkout-api, loadgen, datadog-agent
├── Dockerfile                     # checkout-api container
├── Dockerfile.loadgen             # loadgen container
├── eslint.config.mjs              # ESLint flat config
├── REVIEW.md                      # Instructions for automated code review (Devin Review)
└── .env.example                   # Template for environment variables
```

The daily patrol renders its evidence chart from `docs/patrol-evidence-chart.template.html` by copying it to `/tmp`, replacing the `MEASURED DATA` block with the run's Datadog numbers, and screenshotting it. The template is committed so every run's chart looks the same; the copy and screenshot are never committed. Datadog graph embeds are deliberately not used because the log-based metric only aggregates logs ingested after it was created.

## Tech Stack

- **Runtime:** Node.js 18+ (CommonJS — `require`/`module.exports`)
- **Framework:** Express 5.x
- **Error Tracking:** Sentry (`@sentry/node`)
- **APM/Metrics/Logs:** Datadog (`dd-trace`, `hot-shots` for StatsD)
- **Logging:** Winston (structured JSON)
- **HTTP Client:** Axios
- **Linting:** ESLint 10 (flat config)
- **Containerization:** Docker + Docker Compose

## How to Run Locally

```bash
# Install dependencies
npm install

# Start the app (no Docker, no Datadog agent)
npm start

# The app runs on http://localhost:3000
```

Open `http://localhost:3000` in a browser to see the hub landing page. It lists 9 of the 10 verticals — the payer demo is deliberately absent from `VERTICALS` and reached at `/welcome-season` — and clicking any card opens that demo.

### With Docker (full stack)

```bash
cp .env.example .env
# Fill in SENTRY_DSN, DD_API_KEY, DD_SITE at minimum
docker compose up --build -d
```

This starts 3 services:
- `checkout-api` — Express app on port 3000
- `loadgen` — Synthetic traffic generator (search/login/orders only, no checkout)
- `datadog-agent` — APM traces, metrics, log collection

## How to Lint

```bash
npm run lint
```

This runs ESLint across `app/`, `loadgen/`, `scripts/`, and `pipelines/`. Always run this before committing.

## Alert Pipeline Architecture

```
Vertical Error (any of 10 verticals)
    ├──▶ Sentry (captureException)
    │       └──▶ Sentry Alert Rule fires
    │               └──▶ Webhook to POST /webhooks/sentry
    │                       └──▶ createSessionAndAlert() [fallback path]
    │
    └──▶ createSessionAndAlert() [instant path, non-blocking]
            ├──▶ postBugReportToTriage() — mirrors the bug report to
            │       #automated-devin-triage (report-only, NO Devin session)
            ├──▶ postAlertToSlack() — bot token posts rich alert card
            └──▶ DEVIN_TRIGGER_MODE decides next step:
                    ├── "slack" (default): postDevinReply() — user token @Devin mention
                    │       └──▶ Native Devin Slack integration picks up @mention
                    └── "api": createDevinSession() — POST /v1/sessions
                            └──▶ postDevinSessionLink() — "View in Devin" button in thread
```

**Two error-detection paths exist:**
1. **Instant (all verticals):** Each vertical's route/service calls `createSessionAndAlert()` directly in the catch block (non-blocking, fire-and-forget). This triggers within seconds.
2. **Fallback (Sentry webhook):** `app/routes/sentry-webhook.js` receives the Sentry alert webhook and calls the same `createSessionAndAlert()`. This is slower (depends on Sentry alert rule evaluation).

Both paths call the same `createSessionAndAlert()` function. There is no deduplication — every call creates a new Devin session.

**Two Devin trigger modes exist** (set via `DEVIN_TRIGGER_MODE` env var or per-customer config):
1. **`slack` (default):** Uses `SLACK_USER_TOKEN` to post `@Devin` in the alert thread. The native Devin Slack integration picks up the mention and starts a session. Requires Devin to be installed in the Slack workspace.
2. **`api`:** Calls `POST https://api.devin.ai/v1/sessions` directly via `DEVIN_API_KEY`. Posts a "View in Devin" button in the Slack thread. No user token or Devin Slack app needed — ideal for customer-specific demos running against a different Devin org.

**Per-customer configuration** (see `config/customers.js`):
Multiple customers can run simultaneously in a single deployment, each with their own Devin org/API key. Verticals pass `customer: '<slug>'` in their `alertData` to route to the correct config. Customer-specific env vars use a `_<SLUG>` suffix (e.g. `DEVIN_API_KEY_WAYFAIR`). See [Adding a new customer demo](#adding-a-new-customer-demo) below.

## Key Services

### `app/services/devin-session.js`
- `buildPrompt(alertData)` — Builds a rich Markdown investigation prompt with error details, occurrence info, tags, investigation steps, and context links.
- `createSessionAndAlert(alertData)` — Orchestrates the full alert flow: resolve per-customer config → post Slack alert → trigger Devin (via Slack @mention or API).

### `config/customers.js`
- `getCustomerConfig(customerSlug)` — Resolves Devin trigger config for a customer. Returns `{ triggerMode, apiKey, playbookId, slackUserId, targetRepo }`. Falls back to global env vars for the default customer.
- `CUSTOMERS` — Registry of customer slugs and their config overrides.

### `app/services/devin-api.js`
- `createDevinSession(prompt, options)` — Creates a Devin session via `POST /v1/sessions`. Accepts per-customer `apiKey` and `playbookId` via `options`. Returns `{ sessionId, url }`.

### `app/services/slack.js`
- `postAlertToSlack(alertData)` — Posts the rich Block Kit alert message using `SLACK_BOT_TOKEN`. Returns thread timestamp.
- `postBugReportToTriage(alertData)` — Mirrors the same bug report card to the triage channel (`SLACK_TRIAGE_CHANNEL_ID`, default `#automated-devin-triage`). Report-only: it omits the "Devin AI (auto-investigating)" line and never triggers a Devin session or thread follow-ups. Fire-and-forget; failures (e.g. bot not in channel) are logged and never affect the primary flow.
- `postDevinReply(threadTs, prompt, options)` — (slack mode) Replies in the alert thread using `SLACK_USER_TOKEN` with `@Devin + prompt`. Accepts per-customer `slackUserId` via `options`. Auto-deletes the reply after 5 seconds.
- `postDevinSessionLink(threadTs, sessionUrl)` — (api mode) Posts a "View in Devin" button in the alert thread using `SLACK_BOT_TOKEN`.
- `postMessage()`, `postThreadReply()`, `deleteMessage()` — Low-level Slack API helpers.
- `findChannelByNameFragment(token, fragment)`, `joinChannel(token, channelId)`, `postPersonaMessage(token, channel, text, username, iconEmoji)`, `inviteToChannel(token, channelId, userIds)` — SEV-1 persona chatter helpers. The chatter requires the bot to have the `channels:read`, `channels:join`, and `chat:write.customize` scopes; without `channels:join` the chatter logs a warning and skips seeding (the incident flow is unaffected). Inviting the participants (the triggering user resolved via `users.lookupByEmail`, and Devin via `DEVIN_SLACK_USER_ID`) additionally needs `users:read.email` and `channels:write.invites`; without them the invite logs a warning and is skipped.

### `app/incidentModes.js`
- Manages the current scenario state. Valid scenarios: `healthy`, `slow-db`, `checkout-regression`, `dependency-timeout`.
- The storefront checkout does NOT use scenario modes — it always fails regardless of the current scenario.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SENTRY_DSN` | Sentry project DSN | Yes |
| `DD_API_KEY` | Datadog API key | Yes (for Docker) |
| `DD_SITE` | Datadog site (e.g. `us5.datadoghq.com`) | Yes (for Docker) |
| `DD_INCIDENT_APP_KEY` | Datadog application key for Incident Management (SEV-1 declare/resolve). Owner needs an Incident Management seat. Falls back to `DD_APPLICATION_KEY` | For SEV-1 incidents |
| `ONCALL_SEV1_WINDOW_MS` | SEV-1 degradation window in ms (default 30 min) | No |
| `ONCALL_SEV1_AUTO_RESOLVE` | Set to `false` to leave the Datadog incident open when the window ends — synthetic probe traffic still stops, but responders resolve the incident themselves and Slack auto-archives the channel on its own schedule (default `true`) | No |
| `ONCALL_SEV1_PROBE_INTERVAL_MS` | Base delay between synthetic probe requests against the affected endpoint while a SEV-1 is open, measured from when the previous request completes. The effective delay is this base multiplied per evidence phase (6x/3x/1.5x/1x across the window), so at the default 10s base and 30-min window probes run every ~60s early on and every ~10s in the final phase | No |
| `ONCALL_SEV1_PROBE_MAX` | Max concurrent SEV-1 probe loops (default 25) | No |
| `ONCALL_CONFIG_OVERRIDE_TTL_MS` | Lifetime of a per-run config override (`POST /api/oncall/config`; the shipped baseline comes from `SCREENING_WINDOW_DAYS`/`SCREENING_CONCURRENCY`) when its run has no live incident window to inherit (default 45 min) | No |
| `ONCALL_CONFIG_OVERRIDE_MAX` | Cap on concurrently registered per-run config overrides; at capacity the oldest override without a live incident is evicted first (default 50) | No |
| `SCREENING_WINDOW_DAYS` | Compliance-screening lookback window for the on-call banking transfer path (default 90) | No |
| `SCREENING_CONCURRENCY` | Parallel screening-partner calls per batch on the on-call banking transfer path (default 1) | No |
| `ONCALL_REPO_URL` | Repo URL embedded in on-call Slack cards for responders to investigate (defaults to this repo) | No |
| `ONCALL_DEMO_BASE_URL` | Base URL for branded demo-page links in skinned on-call alerts (defaults to `https://$DOMAIN_NAME`, then devindemos.com) | No |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) for posting alerts | For alerts |
| `SLACK_USER_TOKEN` | Slack user OAuth token (`xoxp-`) for triggering Devin | For slack mode |
| `SLACK_CHANNEL_ID` | Slack channel ID for alert messages | For alerts |
| `SLACK_TRIAGE_CHANNEL_ID` | Channel ID for the report-only bug-report mirror (default `#automated-devin-triage`). Never triggers a Devin session. Bot must be invited to the channel | No |
| `SLACK_TRIAGE_BOT_TOKEN` | Bot token for the triage mirror post (defaults to `SLACK_BOT_TOKEN`) | No |
| `DEVIN_TRIGGER_MODE` | `slack` (default) or `api` — how Devin is triggered | No |
| `DEVIN_API_KEY` | Devin API key | For api mode |
| `DEVIN_SLACK_USER_ID` | Devin app's Slack user ID | For slack mode |
| `DEVIN_PLAYBOOK_ID` | Devin playbook ID for API sessions | No |
| `SONAR_TARGET_REPO` | Target repo for SonarCloud PR (default: `COG-GTM/etl-pipeline-demo`) | No |
| `DEVIN_API_KEY_<SLUG>` | Per-customer Devin API key (e.g. `DEVIN_API_KEY_A6B38C63`) | Per-customer |
| `DEVIN_PLAYBOOK_ID_<SLUG>` | Per-customer playbook ID | No |
| `SONAR_TARGET_REPO_<SLUG>` | Per-customer SonarCloud target repo | No |
| `DOMAIN_NAME` | Domain for Nginx reverse proxy + SSL (e.g. `devindemos.com`) | For SSL |
| `CERT_EMAIL` | Email for Let's Encrypt certificate notifications | For SSL |
| `APP_VERSION` | App version for telemetry | No (default: `1.0.0`) |
| `SENTRY_RELEASE` | Sentry release tag | No (default: `acme-checkout@1.0.0`) |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction of requests traced for performance/spans (1.0=100%, 0=off). Primary lever to control Sentry span volume; does not affect errors or the Slack/Devin alert pipeline | No (default: `0.1`) |
| `SENTRY_PROFILES_SAMPLE_RATE` | Fraction of traced transactions profiled (cannot exceed trace rate) | No (default: `0.1`) |
| `SENTRY_DROPPED_SPAN_OPS` | Comma-separated `span.op` values dropped via Sentry's `ignoreSpans` option (noisy Express router/middleware child spans). Keeps root transactions + db/http spans; does not affect errors or the Slack/Devin pipeline | No (default: `router.express,middleware.express`) |
| `SENTRY_ORG_SLUG` | Sentry organization slug (for issue URLs) | No |
| `SENTRY_PROJECT_ID` | Sentry project ID (for issue URLs) | No |
| `SENTRY_CLIENT_SECRET` | Sentry webhook client secret (HMAC signature verification) | Recommended |
| `DD_DASHBOARD_URL` | Datadog dashboard URL | No |
| `DD_ENV` | Datadog environment tag | No (default: `prod`) |
| `SESSION_SECRET` | Shared secret for session-creating endpoints (`x-session-secret` header) | Recommended |
| `PORT` | Server port | No (default: `3000`) |
| `INTERNAL_JOB_RATE_WINDOW_MS` | Sliding-window duration for internal job requests | No (default: `60000`) |
| `INTERNAL_JOB_PER_IP_RATE_LIMIT` | Accepted internal job requests per IP per window | No (default: `4`) |
| `INTERNAL_JOB_PROCESS_RATE_LIMIT` | Accepted internal job requests process-wide per window | No (default: `6`) |
| `AUTOMATIONS_RUN_TOKEN` | Presenter token for the `/automations` Run Now action; unset disables it | No |
| `AUTOMATIONS_RUN_MAX_PER_HOUR` | Max on-demand patrol sessions per hour (default: `3`) | No |
| `AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES` | Minutes to attach repeated Run Now requests to the last session (default: `45`) | No |
| `LOADGEN_INTERVAL_MS` | Interval between synthetic traffic cycles (higher = less traffic = fewer spans) | No (default: `120000`) |

## Deployment

The app is deployed on an EC2 instance via Docker Compose with Nginx reverse proxy and SSL. The application code lives directly in `/home/ubuntu/` on the EC2 host (not in a subdirectory).

### Architecture

```
Internet → DNS (A record) → EC2 Public IP
                              │
                        ┌─────┴─────┐
                        │   nginx   │  :80 (→ HTTPS redirect)
                        │           │  :443 (SSL termination)
                        └─────┬─────┘
                              │ proxy_pass
                        ┌─────┴──────────┐
                        │  checkout-api  │  :3000 (internal only)
                        └────────────────┘
                        ┌────────────────┐
                        │   certbot      │  (auto-renews certs every 12h)
                        └────────────────┘
```

5 containers: `nginx` (reverse proxy + SSL), `checkout-api` (Express app), `certbot` (certificate renewal), `loadgen` (traffic generator), `datadog-agent` (telemetry).

### Domain & SSL Setup (one-time)

1. **Register a domain** (or use a subdomain of an existing domain)
2. **Create a DNS A record** pointing the domain to the EC2 public IP
3. **Open ports 80 and 443** in the EC2 security group (port 3000 can be closed)
4. **Set env vars** in `/home/ubuntu/.env` on EC2:
   ```bash
   DOMAIN_NAME=devindemos.com
   CERT_EMAIL=your-email@example.com
   ```
5. **Run the SSL init script** (once, on the EC2 host):
   ```bash
   cd /home/ubuntu && bash scripts/init-ssl.sh
   ```
   This starts nginx in HTTP-only mode, obtains a Let's Encrypt certificate via certbot, then restarts the full stack with SSL enabled.
6. **Update Sentry webhook URL** to `https://devindemos.com/webhooks/sentry`

After the initial setup, certificate renewal is fully automatic (certbot checks every 12 hours, nginx reloads every 6 hours).

### EC2 Redeploy Steps

Deployments are automated via GitHub Actions on push to `main`. For manual redeploy:

```bash
# 1. Build tarball from latest main (locally or on your dev machine)
git checkout main && git pull origin main
tar czf /tmp/acme-demo.tar.gz --exclude=node_modules --exclude=.git --exclude=.env --exclude=certbot -C . .

# 2. Back up the .env on EC2 BEFORE extracting (critical — secrets live here)
ssh ubuntu@<EC2_IP> "cp /home/ubuntu/.env /home/ubuntu/.env.bak"

# 3. SCP the tarball to EC2
scp /tmp/acme-demo.tar.gz ubuntu@<EC2_IP>:/home/ubuntu/acme-demo.tar.gz

# 4. Extract over existing code (the --exclude above ensures .env and certs are not in the tarball)
ssh ubuntu@<EC2_IP> "cd /home/ubuntu && tar xzf acme-demo.tar.gz"

# 5. Verify .env is still present (if missing, restore from backup)
ssh ubuntu@<EC2_IP> "test -f /home/ubuntu/.env || cp /home/ubuntu/.env.bak /home/ubuntu/.env"

# 6. Stop old containers, rebuild, and start
ssh ubuntu@<EC2_IP> "cd /home/ubuntu && docker compose down && docker compose up -d --build"

# 7. Verify the app is healthy
ssh ubuntu@<EC2_IP> "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health"
# Should return 200
```

### Important Notes

- **`.env` location:** The production `.env` file lives at `/home/ubuntu/.env` on EC2. It contains all secrets (`SENTRY_DSN`, `DD_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `DOMAIN_NAME`, `CERT_EMAIL`, etc.) and must never be overwritten or deleted.
- **SSL certificates:** Stored in `./certbot/conf/` on EC2. These persist across deploys — the tarball and deploy workflow explicitly exclude this directory. Never delete this directory or you'll need to re-run `scripts/init-ssl.sh`.
- **Backup before deploy:** Always back up `.env` before extracting the tarball. If the `.env` is accidentally removed, Slack alerts, Sentry, and Datadog will silently stop working.
- **Port conflicts:** If `docker compose up` fails with port-in-use errors, run `docker compose down` first or `docker rm -f $(docker ps -aq)` to clean up stale containers from previous deployments.
- **Old deploy path:** An earlier deployment used `/home/ubuntu/acme-demo/` as the app directory. If you find a `.env` at that path but not at `/home/ubuntu/.env`, copy it: `cp /home/ubuntu/acme-demo/.env /home/ubuntu/.env`.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the Express app |
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm run lint` | Run ESLint |
| `npm run loadgen` | Run traffic generator standalone |
| `npm run features:build` | Rebuild the Kroger offer-affinity feature view from its spec |
| `npm run features:check` | Fail if the committed feature artifact is stale relative to the spec |
| `npm run audit:kroger` | Score every membership tier through the ranker (exits 1 on any coverage gap) |
| `npm run feed:build` | Rebuild the SPGI feed field contract from its mapping spec |
| `npm run feed:check` | Fail if the committed feed contract is stale relative to the spec |
| `npm run audit:spgi` | Drive every instrument class through the parity harness (exits 1 on any uncovered class) |
| `npm run patrol:digest -- findings.json` | Format a validated Slow Query Patrol Slack digest |
| `npm run patrol:before-after -- --before URL --after URL --path PATH --runs N [--pause MS]` | Compare pre-fix and fixed patrol job responses |
| `npm run patrol:compare-page -- --before URL --after URL --path PATH [--port N]` | Serve a labelled side-by-side page of both patrol job responses |
| `npm run demo:trigger` | Trigger an error scenario |
| `npm run demo:reset` | Reset to healthy state |
| `npm run demo:warmup` | Pre-warm the app |
| `npm run demo:cleanup` | Clean up resources |

## Conventions

- **CommonJS modules** — Use `require()` and `module.exports`, not ES module syntax.
- **Structured logging** — Use the Winston logger (`require('../telemetry/logger')`) for all log output. Do not use `console.log` in app code.
- **Environment variables** — All secrets and configuration come from env vars. Never hardcode credentials.
- **Error handling** — Errors are captured with `Sentry.captureException()` and logged with the structured logger. Metrics are recorded via Datadog StatsD.
- **Lint before commit** — Always run `npm run lint` before committing. The ESLint config uses flat config format (`eslint.config.mjs`).
- **No force pushes** — Never force push. Use new commits to fix issues.
- **Prefix unused params** — Prefix unused function parameters with `_` (e.g. `_req`, `_next`) to satisfy the ESLint `no-unused-vars` rule.

## Testing

Unit tests live in `tests/` and run with `npm test` (Jest). Most verification is still done manually:

1. Run `npm start` or `docker compose up`
2. Open `http://localhost:3000` in a browser — you'll see the hub landing page
3. Click any vertical card to open its demo
4. Perform the primary action for that vertical (e.g., transfer funds, execute trade, submit claim)
5. Verify error appears (before fix) or action succeeds (after fix)
6. Check Sentry for captured exceptions
7. Check Datadog for APM traces and metrics
8. Check Slack for alert messages (if configured)

### Vertical URLs for Quick Access

When the app is running (locally at `localhost:3000` or on EC2 via `https://<DOMAIN_NAME>`):

| Vertical | URL |
|----------|-----|
| Hub | `https://<DOMAIN_NAME>/` |
| Retail | `https://<DOMAIN_NAME>/retail` |
| Banking | `https://<DOMAIN_NAME>/banking` |
| Financial Services | `https://<DOMAIN_NAME>/financial-services` |
| Insurance | `https://<DOMAIN_NAME>/insurance` |
| CPG | `https://<DOMAIN_NAME>/cpg` |
| High Tech | `https://<DOMAIN_NAME>/hightech` |
| Industrials | `https://<DOMAIN_NAME>/industrials` |
| Healthcare | `https://<DOMAIN_NAME>/healthcare` |
| Telco | `https://<DOMAIN_NAME>/telco` |
| Payer (welcome season) | `https://<DOMAIN_NAME>/welcome-season` |

## External Integrations

| Service | Purpose | Config |
|---------|---------|--------|
| Sentry | Error tracking, alert rules, webhooks | `SENTRY_DSN`, `SENTRY_ORG_SLUG` |
| Datadog | APM, metrics, logs, dashboard | `DD_API_KEY`, `DD_SITE` |
| Slack (`#automated-alerts`) | Alert notifications, Devin triggering | `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN` (slack mode), `SLACK_CHANNEL_ID` |
| [Devin API](https://api.devin.ai) | Direct session creation (api mode) | `DEVIN_API_KEY` |
| Datadog Dashboard | checkout-api overview | `DD_DASHBOARD_URL` |

## Common Tasks

### Adding a new API endpoint
1. Create a route file in `app/routes/`
2. Mount it in `app/server.js`
3. Add structured logging and Sentry/Datadog instrumentation
4. Run `npm run lint`

### Modifying the Slack alert format
Edit `buildAlertBlocks()` in `app/services/slack.js`. The function returns Slack Block Kit JSON. See [Block Kit Builder](https://app.slack.com/block-kit-builder) for visual editing.

### Modifying the Devin investigation prompt
Edit `buildPrompt()` in `app/services/devin-session.js`. The prompt uses GFM Markdown tables for structured data. Keep it detailed — this is the only context Devin gets when starting an investigation.

### Adding a new customer demo
1. Add the customer slug to `config/customers.js` in the `CUSTOMERS` object:
   ```js
   acme: {
     label: 'Acme Corp',
     triggerMode: 'api',
   },
   ```
2. Set the customer's env vars (suffixed with `_<SLUG>`):
   ```
   DEVIN_API_KEY_ACME=dv-abc123...
   SONAR_TARGET_REPO_ACME=COG-GTM/acme-etl-pipeline
   ```
3. Pass `customer: 'acme'` in the vertical's `alertData` when calling `createSessionAndAlert()`.
4. Add the env vars to `docker-compose.yml` and `.env.example`.

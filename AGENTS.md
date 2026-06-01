# AGENTS.md — Guide for AI Software Engineering Agents

This document describes the **Event-Driven Devin** demo repository for AI agents that are asked to investigate, fix, or extend the codebase.

## What This Repo Is

A Node.js/Express application with integrated observability (Sentry + Datadog) and automated incident response (Slack alerts + Devin). The app serves **9 industry vertical demos**, each with its own frontend, API routes, and business logic. Each vertical has a production bug that produces a `TypeError` when its primary action is triggered. When an error occurs, the system automatically posts an alert to Slack and triggers a Devin session to investigate and fix it.

## Industry Verticals

The app hosts 9 verticals, each accessible at its own URL:

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

Each vertical follows the same flow: **User action → Bug triggers → Sentry/Datadog capture → Slack alert → Devin investigates → PR created**.

## Repository Structure

```
├── app/
│   ├── server.js                  # Express app entry point (mounts all vertical routes)
│   ├── incidentModes.js           # Scenario state management (healthy, checkout-regression, etc.)
│   ├── public/
│   │   ├── hub.html               # Landing page with cards for all 9 verticals
│   │   ├── index.html             # Retail eCommerce storefront UI
│   │   └── verticals/
│   │       ├── banking.html       # Apex Bank — Online Banking
│   │       ├── financial-services.html  # Meridian Capital — Trading Platform
│   │       ├── insurance.html     # Shield Insurance — Claims Portal
│   │       ├── cpg.html           # Harvest Goods — Distributor Orders
│   │       ├── hightech.html      # NovaSoft — SaaS License Management
│   │       ├── industrials.html   # Titan Mfg — Equipment Maintenance
│   │       ├── healthcare.html    # CarePoint — Patient Portal
│   │       └── telco.html         # WaveConnect — Telecom Self-Service
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
│   │   │   └── telco.js           # Telco: plans + upgrades
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
│   │   │   └── telco.js           # Plan upgrade business logic
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
│   ├── trigger.js                 # Manually trigger error scenarios
│   ├── warmup.js                  # Pre-warm the app
│   ├── reset.js                   # Reset scenario to healthy
│   └── cleanup.js                 # Clean up resources
├── config/
│   └── scenarios.json             # Scenario definitions
├── docker-compose.yml             # 3 services: checkout-api, loadgen, datadog-agent
├── Dockerfile                     # checkout-api container
├── Dockerfile.loadgen             # loadgen container
├── eslint.config.mjs              # ESLint flat config
├── REVIEW.md                      # Instructions for automated code review (Devin Review)
└── .env.example                   # Template for environment variables
```

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

Open `http://localhost:3000` in a browser to see the hub landing page with all 9 industry verticals. Click any vertical card to open its demo.

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

This runs ESLint across `app/`, `loadgen/`, and `scripts/`. Always run this before committing.

## Alert Pipeline Architecture

```
Vertical Error (any of 9 verticals)
    ├──▶ Sentry (captureException)
    │       └──▶ Sentry Alert Rule fires
    │               └──▶ Webhook to POST /webhooks/sentry
    │                       └──▶ createSessionAndAlert() [fallback path]
    │
    └──▶ createSessionAndAlert() [instant path, non-blocking]
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
- `postDevinReply(threadTs, prompt, options)` — (slack mode) Replies in the alert thread using `SLACK_USER_TOKEN` with `@Devin + prompt`. Accepts per-customer `slackUserId` via `options`. Auto-deletes the reply after 5 seconds.
- `postDevinSessionLink(threadTs, sessionUrl)` — (api mode) Posts a "View in Devin" button in the alert thread using `SLACK_BOT_TOKEN`.
- `postMessage()`, `postThreadReply()`, `deleteMessage()` — Low-level Slack API helpers.

### `app/incidentModes.js`
- Manages the current scenario state. Valid scenarios: `healthy`, `slow-db`, `checkout-regression`, `dependency-timeout`.
- The storefront checkout does NOT use scenario modes — it always fails regardless of the current scenario.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SENTRY_DSN` | Sentry project DSN | Yes |
| `DD_API_KEY` | Datadog API key | Yes (for Docker) |
| `DD_SITE` | Datadog site (e.g. `us5.datadoghq.com`) | Yes (for Docker) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) for posting alerts | For alerts |
| `SLACK_USER_TOKEN` | Slack user OAuth token (`xoxp-`) for triggering Devin | For slack mode |
| `SLACK_CHANNEL_ID` | Slack channel ID for alert messages | For alerts |
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
| `LOADGEN_INTERVAL_MS` | Interval between synthetic traffic cycles (higher = less traffic = fewer spans) | No (default: `300000`) |

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

There are no automated tests in this repo. Verification is done manually:

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

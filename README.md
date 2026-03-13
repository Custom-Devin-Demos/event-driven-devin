# Acme Commerce — Observability Demo

A small demo SaaS app ("Acme Commerce") that is always running, always receiving traffic, and always emitting telemetry to **Sentry** and **Datadog**. Designed for realistic Devin investigation workflows.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Traffic         │────▶│  Checkout API    │────▶│  Sentry         │
│  Generator       │     │  (Express/Node)  │────▶│  Datadog Agent  │
│  (loadgen)       │     │  Port 3000       │     │  (APM + Logs)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌──────────────┐
                        │  GitHub       │
                        │  Webhooks     │
                        └──────────────┘
```

### Components

| Component | Description |
|-----------|-------------|
| **Checkout API** | Express app with 5 business endpoints + admin controls |
| **Traffic Generator** | Always-on worker sending realistic synthetic traffic |
| **Datadog Agent** | Collects APM traces, metrics, and logs |
| **Incident Control** | Admin endpoint to toggle demo scenarios |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with version and scenario info |
| `POST` | `/login` | User authentication (synthetic users) |
| `GET` | `/search?q=...` | Product catalog search |
| `POST` | `/checkout` | Main checkout flow (incident target) |
| `GET` | `/orders/:id` | Order lookup |
| `GET` | `/orders` | List all orders |
| `GET` | `/admin/scenario` | Get current scenario |
| `POST` | `/admin/scenario` | Switch incident scenario |
| `GET` | `/admin/info` | App debug info |
| `POST` | `/webhook/github` | GitHub webhook receiver |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Sentry account with a Node.js project (need DSN)
- Datadog account (need API key)

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env with your real values:
#   SENTRY_DSN=https://...@....ingest.sentry.io/...
#   DD_API_KEY=your-datadog-api-key
#   DD_SITE=datadoghq.com
```

### 2. Start everything

```bash
docker-compose up --build -d
```

This starts:
- `checkout-api` on port 3000
- `loadgen` (traffic generator)
- `datadog-agent` (APM + metrics + logs)

### 3. Verify

```bash
curl http://localhost:3000/health
```

### Running without Docker

```bash
npm install
npm start          # Start the API
npm run loadgen    # Start the traffic generator (in another terminal)
```

## Incident Scenarios

Switch scenarios via the admin endpoint:

```bash
# View current scenario
curl http://localhost:3000/admin/scenario

# Switch to a scenario
curl -X POST http://localhost:3000/admin/scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario": "checkout-regression"}'
```

Or use the helper scripts:

```bash
node scripts/trigger.js checkout-regression
node scripts/trigger.js healthy
```

### Available Scenarios

| Scenario | Description | Best For |
|----------|-------------|----------|
| `healthy` | All systems normal (default) | Baseline |
| `slow-db` | DB queries take 1.5-3s | Datadog latency investigation |
| `checkout-regression` | Null reference bug in `calculateTax` | Sentry + GitHub investigation |
| `dependency-timeout` | Payment gateway 30% timeout rate | Combined investigation |

### Scenario Details

**`checkout-regression`** (recommended for demos):
- Simulates a bad deploy (`v1.0.1`) that introduced a null reference in the `calculateTax` function
- ~40% of `/checkout` requests throw `TypeError: Cannot read properties of null (reading 'taxRate')`
- ~15% throw `InventoryReservationError`
- Sentry shows new issue correlated to release `acme-checkout@1.0.1`
- Datadog shows error rate spike and latency change by version

**`slow-db`**:
- `/checkout` and `/search` have 1.5-3s added latency
- Great for showing Datadog p95/p99 latency dashboards

**`dependency-timeout`**:
- 30% of `/checkout` requests fail with `PaymentGatewayTimeoutError`
- 5s timeout on failures
- Shows both error rate and latency impact

## Demo Scripts

```bash
npm run demo:reset    # Set to healthy, verify all endpoints
npm run demo:warmup   # 15 minutes of traffic to populate dashboards
npm run demo:trigger  # Switch scenario (pass scenario name as arg)
npm run demo:cleanup  # Reset to healthy after demo
```

## Traffic Generator

The load generator sends realistic traffic with:
- **3 synthetic personas**: buyer_1, buyer_2, admin_ops
- **Time-based volume**: lower overnight, moderate daytime
- **Per minute**: ~6 search, ~3 login, ~2 orders, ~2 checkout
- **Every 10 min**: slow burst (extra requests)
- **Every 30 min**: error cluster

Target ratios: 92-96% success, 3-6% slow, 1-2% failures.

## Telemetry

### Sentry Tags
- `environment=demo`
- `release=acme-checkout@1.0.x`
- `scenario=healthy|slow-db|checkout-regression|dependency-timeout`
- `tenant=synthetic`
- `customer=acme-demo`

### Datadog Tags (Unified Service Tagging)
- `env:demo`
- `service:checkout-api`
- `version:1.0.x`

### Custom Metrics (DogStatsD)
- `demo.checkout.success`
- `demo.checkout.failure`
- `demo.checkout.latency`
- `demo.search.requests`
- `demo.search.latency`
- `demo.login.success`
- `demo.login.latency`
- `demo.orders.lookup`
- `demo.orders.latency`

## Demo Flow (Recommended)

### Before the call
1. App has been running with traffic for at least 15 minutes
2. Run `npm run demo:warmup` if dashboards need populating
3. Current scenario is `healthy`

### During the call
1. Show the app and explain the architecture
2. Trigger the incident: `node scripts/trigger.js checkout-regression`
3. Wait 2-3 minutes for errors to accumulate
4. Ask Devin to investigate the checkout failures
5. Devin checks Sentry → finds new null reference issue after release 1.0.1
6. Devin checks Datadog → confirms latency spike and error concentration
7. Devin checks GitHub → identifies the PR that introduced the bug
8. Devin proposes a fix
9. Reset: `node scripts/trigger.js healthy`

## Deployment

Deployment configs are provided for multiple platforms. Choose one:

### Option A: Docker Compose (local or VM)

Best for EC2 / any VM with Docker installed:

```bash
cp .env.example .env
# Fill in SENTRY_DSN, DD_API_KEY, DD_SITE
docker-compose up --build -d
```

### Option B: Railway

1. Connect this repo in the [Railway dashboard](https://railway.app)
2. Railway auto-detects `railway.json`
3. Set environment variables in the Railway dashboard: `SENTRY_DSN`, `DD_API_KEY`, `DD_SITE`
4. Deploy the loadgen as a separate service using `Dockerfile.loadgen`

### Option C: Render

1. Connect this repo in the [Render dashboard](https://dashboard.render.com)
2. Render auto-detects `render.yaml` (Blueprint)
3. Set secret env vars (`SENTRY_DSN`, `DD_API_KEY`, `DD_SITE`) in the Render dashboard

### Option D: Fly.io

```bash
fly launch --copy-config --no-deploy
fly secrets set SENTRY_DSN=... DD_API_KEY=... DD_SITE=...
fly deploy
```

> **Note:** The Datadog Agent requires Docker socket access and is best run via Docker Compose (Option A) or as a sidecar. For Railway/Render/Fly.io, you can run the app and loadgen without the agent and use Datadog's agentless APM or deploy the agent separately.

## Observability Dashboards

### Datadog Dashboard (automated)

Create the pre-built "Acme Commerce - Checkout API Overview" dashboard:

```bash
DD_API_KEY=xxx DD_APP_KEY=xxx DD_SITE=datadoghq.com node scripts/setup-datadog-dashboard.js
```

This creates a dashboard with:
- Request throughput and error rate
- p95 latency
- Checkout success/failure counters (DogStatsD)
- Error rate and latency by version (for release regression story)
- Log stream filtered to `service:checkout-api env:demo`

> You need a **Datadog Application Key** (not just API key) for dashboard creation. Create one at [Organization Settings > Application Keys](https://app.datadoghq.com/organization-settings/application-keys).

### Sentry Alerts (automated)

Create alert rules for the demo:

```bash
SENTRY_AUTH_TOKEN=xxx SENTRY_ORG=xxx SENTRY_PROJECT=xxx node scripts/setup-sentry-alerts.js
```

This creates:
- **Checkout Error Spike** — triggers when >5 checkout-regression errors in 5 minutes
- **New Issue on Release** — triggers on first-seen issues

> Create a Sentry auth token at [Settings > Auth Tokens](https://sentry.io/settings/auth-tokens/) with `project:read` and `alerts:write` scopes.

### Sentry Dashboard (manual)

Sentry dashboards must be created in the UI. Go to **Dashboards > Create Dashboard** and add:

| Widget | Type | Query |
|--------|------|-------|
| Issues by Release | Table | `is:unresolved`, group by `release` |
| Error Trend (24h) | Line chart | `event.type:error`, Y: `count()` |
| Checkout API Traces | Line chart | `transaction:/checkout`, Y: `p95(transaction.duration)` |
| Top Failing Endpoints | Table | `event.type:error`, group by `transaction` |
| Latest Regressions | Table | `is:unresolved is:regression` |

## Demo Narrative (Git History)

The repo contains a realistic git history for the investigation story:

| Version | PR | Description |
|---------|-----|-------------|
| `v1.0.0` | — | Stable checkout, all scenarios working |
| `v1.0.1` | PR #3: "optimize tax calculation" | Introduces null reference bug (removes region fallback) |
| `v1.0.2` | PR #4: "fix nil tax region in checkout" | Fixes the bug (restores fallback) |

This lets Devin trace the regression from Sentry/Datadog back to the specific PR and commit.

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `SENTRY_DSN` | Sentry project DSN | Yes |
| `DD_API_KEY` | Datadog API key | Yes |
| `DD_SITE` | Datadog site (e.g., `datadoghq.com`) | Yes |
| `APP_SCENARIO` | Initial scenario on startup | No (default: `healthy`) |
| `APP_VERSION` | App version for tagging | No (default: `1.0.0`) |
| `PORT` | API port | No (default: `3000`) |

# Acme Commerce

A modern e-commerce storefront built with Node.js and Express, featuring a premium dark luxury UI, real-time cart management, and integrated observability via Sentry and Datadog.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Express](https://img.shields.io/badge/Express-4.x-lightgrey)
![Docker](https://img.shields.io/badge/Docker-Compose-blue)

## Features

- **Storefront UI** — Dark luxury aesthetic with Cormorant Garamond typography, gold accents, and smooth animations
- **Product Catalog** — Browse and search products across widgets, gadgets, tools, and accessories
- **Cart & Checkout** — Slide-out cart drawer with quantity management and full checkout flow
- **Observability** — Integrated Sentry error tracking and Datadog APM/metrics/logs
- **Automated Alerts** — Sentry webhook integration that auto-creates investigation sessions on errors

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- [Sentry](https://sentry.io) account (for error tracking)
- [Datadog](https://www.datadoghq.com) account (for APM and metrics)

### 1. Configure environment

```bash
cp .env.example .env
```

Set the following in `.env`:

| Variable | Description |
|----------|-------------|
| `SENTRY_DSN` | Sentry project DSN |
| `DD_API_KEY` | Datadog API key |
| `DD_SITE` | Datadog site (e.g. `us5.datadoghq.com`) |
| `DEVIN_API_KEY` | Devin API key for auto-investigation (optional) |
| `DEVIN_ORG_ID` | Devin organization ID (optional) |

### 2. Start the application

```bash
docker-compose up --build -d
```

This starts three services:
- **checkout-api** — Express app on port 3000
- **loadgen** — Synthetic traffic generator
- **datadog-agent** — APM traces, metrics, and log collection

### 3. Verify

```bash
curl http://localhost:3000/health
```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the storefront.

### Running without Docker

```bash
npm install
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Storefront UI |
| `GET` | `/health` | Health check |
| `GET` | `/api/products` | Product catalog |
| `POST` | `/api/storefront/checkout` | Process checkout |
| `POST` | `/login` | User authentication |
| `GET` | `/search?q=...` | Product search |
| `POST` | `/checkout` | Checkout (API) |
| `GET` | `/orders/:id` | Order lookup |
| `GET` | `/orders` | List orders |
| `POST` | `/webhooks/sentry` | Sentry alert webhook |

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
                        │  Devin API   │
                        │  (auto-fix)  │
                        └──────────────┘
```

## Deployment

### Docker Compose (EC2 / VM)

```bash
cp .env.example .env
# Fill in SENTRY_DSN, DD_API_KEY, DD_SITE
docker-compose up --build -d
```

The application runs on port 3000. Make sure to open port 3000 in your security group / firewall.

## Observability

### Sentry

Error tracking with automatic alert rules:

- **Checkout Error Spike** — Triggers on elevated error rates
- **New Issue on Release** — Triggers on first-seen issues
- **Regression Detected** — Triggers when a resolved issue reappears

### Datadog

APM tracing, custom metrics, and structured logging:

- **APM Traces** — Full distributed tracing for all requests
- **Custom Metrics** — Checkout success/failure counters, latency histograms
- **Logs** — Structured JSON logs with trace correlation

### Sentry Webhook → Devin Integration

When a Sentry alert fires, the `/webhooks/sentry` endpoint automatically creates a [Devin](https://devin.ai) session to investigate the error. The session includes:

- Full error details (type, message, stack trace location, severity)
- Occurrence metadata (first/last seen, event count, release, environment)
- Tags and extra context from the Sentry event
- Instructions to use Sentry and Datadog MCP integrations for investigation

## Setup Scripts

```bash
# Create Datadog dashboard
DD_API_KEY=xxx DD_APP_KEY=xxx DD_SITE=us5.datadoghq.com node scripts/setup-datadog-dashboard.js

# Create Sentry alert rules
SENTRY_AUTH_TOKEN=xxx SENTRY_ORG=xxx SENTRY_PROJECT=xxx node scripts/setup-sentry-alerts.js
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SENTRY_DSN` | Sentry project DSN | Yes |
| `DD_API_KEY` | Datadog API key | Yes |
| `DD_SITE` | Datadog site (e.g. `us5.datadoghq.com`) | Yes |
| `DEVIN_API_KEY` | Devin API key for auto-investigation | No |
| `DEVIN_ORG_ID` | Devin organization ID | No |
| `APP_VERSION` | App version for telemetry tagging | No (default: `1.0.0`) |
| `PORT` | API port | No (default: `3000`) |

## License

Private — internal use only.

# Review Guidelines

## Known Intentional Patterns

The following patterns are intentional and should NOT be flagged as bugs:

- Each of the 9 industry verticals (`app/services/verticals/*.js` and `app/routes/storefront.js`) contains an intentional bug that produces a `TypeError` when the vertical's primary action is triggered. These bugs exist so that errors flow to Sentry and Datadog for observability monitoring, and trigger automated Devin investigation sessions via Slack. Do not fix these bugs unless explicitly asked to investigate a specific vertical's error.
- Dead code after intentional error paths — Any code paths that follow the bug-triggered exceptions (e.g., success responses, metric increments) are unreachable by design and should not be flagged.
- `app/services/checkout.js` contains scenario-based bugs (e.g., `checkout-regression`) that are intentional for the same observability demo purpose.

## Ignore

- Lock files (`package-lock.json`) do not need review.
- `app/public/index.html` and `app/public/verticals/*.html` are single-file vanilla HTML/CSS/JS frontends — standard web review rules apply but framework-specific conventions do not.
- `app/public/hub.html` is the landing page linking to all 9 verticals.
- `scripts/` contains one-off setup utilities and does not need deep review.
- `loadgen/` is a synthetic traffic generator and does not need production-quality review.

## Conventions

- This is a Node.js/Express application using CommonJS (`require`/`module.exports`).
- Logging uses structured JSON via Winston (`app/telemetry/logger.js`).
- Telemetry is dual-shipped to Sentry (errors) and Datadog (APM, metrics, logs).
- Environment variables are used for all secrets and configuration — never hardcode credentials.

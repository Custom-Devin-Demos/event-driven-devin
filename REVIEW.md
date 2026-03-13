# Review Guidelines

## Known Intentional Patterns

The following patterns are intentional and should NOT be flagged as bugs:

- `TAX_REGIONS[null]` in `app/routes/storefront.js` — This is intentional. The storefront checkout is designed to always produce a `TypeError` so that errors flow to Sentry and Datadog for observability monitoring. The success path below the null lookup is unreachable by design.
- `const region = null; const taxRate = region.taxRate;` in `app/services/checkout.js` — This is an intentional null dereference inside the `checkout-regression` scenario path. It produces a `TypeError` to simulate a production regression for observability tooling.
- Dead code after intentional throws — Any code paths that follow the above null dereferences (e.g., success responses, metric increments) are unreachable by design and should not be flagged.

## Ignore

- Lock files (`package-lock.json`) do not need review.
- `app/public/index.html` is a single-file vanilla HTML/CSS/JS storefront — standard web review rules apply but framework-specific conventions do not.
- `scripts/` contains one-off setup utilities and does not need deep review.
- `loadgen/` is a synthetic traffic generator and does not need production-quality review.

## Conventions

- This is a Node.js/Express application using CommonJS (`require`/`module.exports`).
- Logging uses structured JSON via Winston (`app/telemetry/logger.js`).
- Telemetry is dual-shipped to Sentry (errors) and Datadog (APM, metrics, logs).
- Environment variables are used for all secrets and configuration — never hardcode credentials.

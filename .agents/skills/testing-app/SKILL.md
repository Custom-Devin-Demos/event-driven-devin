# Testing event-driven-devin

## Quick Start

```bash
cd /home/ubuntu/repos/event-driven-devin
npm install
PORT=3000 node app/server.js
```

The app starts without external services (Sentry, Datadog, Slack are optional). Health check: `GET /health`.

## Key Pages

- `/` — Hub landing page with vertical cards
- `/retail` — Retail storefront with checkout demo
- `/banking`, `/insurance`, `/cpg`, etc. — Industry vertical demo pages
- `/{uuid}` — Customer-specific vertical pages (UUIDs map to customers, see `config/customers.js`)

## Key API Endpoints

- `GET /api/verticals` — Returns all vertical metadata (JSON)
- `GET /api/{uuid}/catalog` — Customer-specific catalog
- `POST /api/storefront/checkout` — Storefront checkout (intentionally triggers TypeError for demo)
- `POST /webhooks/sentry` — Sentry webhook receiver (HMAC verification when `SENTRY_CLIENT_SECRET` is set)

## Testing Middleware Verification

To test Sentry webhook HMAC verification:

```bash
# Restart with secret
SENTRY_CLIENT_SECRET=test-secret-123 PORT=3000 node app/server.js &

# No signature → 401
curl -s -X POST http://localhost:3000/webhooks/sentry \
  -H 'Content-Type: application/json' \
  -d '{"action":"triggered"}'

# Invalid signature → 403
curl -s -X POST http://localhost:3000/webhooks/sentry \
  -H 'Content-Type: application/json' \
  -H 'sentry-hook-signature: invalid' \
  -d '{"action":"triggered"}'

# Valid HMAC → passes through
BODY='{"action":"triggered"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret-123" | awk '{print $NF}')
curl -s -X POST http://localhost:3000/webhooks/sentry \
  -H 'Content-Type: application/json' \
  -H "sentry-hook-signature: $SIG" \
  -d "$BODY"
```

Similarly, `SESSION_SECRET` env var gates the `verifySessionSecret` middleware (used via `x-session-secret` header). When not set, middleware is a no-op.

## Checkout Demo Behavior

The `/retail` page's "Place Order" button triggers `POST /api/storefront/checkout`. This intentionally returns a TypeError ("Cannot read properties of undefined") — it's the demo bug that triggers Sentry alerts and Devin session creation. This is expected behavior, not a real error.

## Customer UUID Mapping

Customer names are anonymized as UUIDs in routes and config. The mapping is in `config/customers.js`. Customer-specific env vars use `_<UUID>` suffixes (e.g., `DEVIN_API_KEY_A6B38C63`).

## Lint

```bash
npm run lint
```

There may be 2 pre-existing warnings (no-unused-vars) — these are not errors.

## Node version pitfall

`which node` in non-interactive shells may resolve to an old Node (v12), which crashes on optional chaining in `app/server.js`. Check `node -v` first and select Node 18+ via nvm (e.g. `source ~/.nvm/nvm.sh && nvm use 20`) before `node app/server.js`; check `/tmp` logs if all routes return 000.

## Webinar pages (/webinars/<slug>)

Introduced by PR #4821 — this section applies once that branch/PR is in your checkout.

- Registry: `config/webinars.js` (slug → webinarId/webinarTitle/customerName). Page template: `app/public/webinars/<slug>.html`.
- `GET /webinars/:slug` 404s for unregistered slugs; `POST /api/webinars/:slug/signup` writes rows keyed by `webinarId` to `data/webinar-registrations.json`.
- Use only synthetic names/emails (e.g. synthetic.test@example.com) and delete `data/webinar-registrations.json` after testing. Alert emails are metadata-only, fire-and-forget (no SENDGRID key locally → harmless warn).
- Legacy `/webinar` (Humana) writes to `data/webinar-signups.json` and is unchanged.

## Notes

- The app uses Express 5 with `express.json()` middleware
- Raw body is captured for webhook signature verification (`req.rawBody`)
- Vertical HTML pages contain branded content (product images, logos) — this is intentional for the demo
- Port conflicts: use `fuser -k 3000/tcp` to kill existing processes before restarting

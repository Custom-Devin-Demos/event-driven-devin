# Runbook — Carrefour checkout-service (vertical 2351d2b1, /carrefour)

On a checkout alert: pull the last 15 minutes of ERROR logs from
`carrefour-checkout-service` (vertical `2351d2b1`, brand `Carrefour`), identify the
top error, check vendor changelogs under `docs/2351d2b1/vendors`, propose a fix with
tests, open a PR, post a root-cause summary to the alert thread.

## Where things live

- Checkout orchestration + metrics + alerting: `app/services/verticals/2351d2b1.js`
- Meridian Pay client adapter: `app/services/verticals/2351d2b1-meridian.js`
- Meridian Pay simulator (vendor side): `app/services/verticals/2351d2b1-meridian-psp.js`
- Orders store: `app/services/verticals/2351d2b1-orders.js`
- HTTP routes (storefront API + `/api/2351d2b1/psp` vendor API + `/api/2351d2b1/demo/*` controls): `app/routes/verticals/2351d2b1.js`
- Storefront page: `app/public/verticals/2351d2b1.html` (served at `/carrefour` and `/2351d2b1`)
- Metrics endpoint: `GET /api/2351d2b1/metrics`
- Tests: `tests/2351d2b1-*.test.js`

## After deploy

Stranded `pending` orders that were charged can be completed with
`POST /api/2351d2b1/orders/:id/complete` (`{ "paymentId": "<pspReference>" }`);
duplicate authorizations are listed by `GET /api/2351d2b1/psp/v1/authorizations`
and voided with `POST /api/2351d2b1/psp/v1/payments/:id/void`.

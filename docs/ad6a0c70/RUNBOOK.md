# Runbook — La Poste checkout-service (vertical ad6a0c70, /laposte)

On a checkout alert: pull the last 15 minutes of ERROR logs from
`laposte-checkout-service` (vertical `ad6a0c70`, brand `La Poste`), identify the
top error, check vendor changelogs under `docs/ad6a0c70/vendors`, propose a fix with
tests, open a PR, post a root-cause summary to the alert thread.

## Where things live

- Checkout orchestration + metrics + alerting: `app/services/verticals/ad6a0c70.js`
- Meridian Pay client adapter: `app/services/verticals/ad6a0c70-meridian.js`
- Meridian Pay simulator (vendor side): `app/services/verticals/ad6a0c70-meridian-psp.js`
- Orders store: `app/services/verticals/ad6a0c70-orders.js`
- HTTP routes (storefront API + `/api/ad6a0c70/psp` vendor API + `/api/ad6a0c70/demo/*` controls): `app/routes/verticals/ad6a0c70.js`
- Storefront page: `app/public/verticals/ad6a0c70.html` (served at `/laposte` and `/ad6a0c70`)
- Metrics endpoint: `GET /api/ad6a0c70/metrics`
- Tests: `tests/ad6a0c70-*.test.js`

## After deploy

Stranded `pending` orders that were charged can be completed with
`POST /api/ad6a0c70/orders/:id/complete` (`{ "paymentId": "<pspReference>" }`);
duplicate authorizations are listed by `GET /api/ad6a0c70/psp/v1/authorizations`
and voided with `POST /api/ad6a0c70/psp/v1/payments/:id/void`.

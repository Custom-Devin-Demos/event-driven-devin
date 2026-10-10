# Runbook — Ralph Lauren checkout-service (customer f63013c0)

On a checkout alert: pull the last 15 minutes of ERROR logs from `checkout-service`
(customer `f63013c0`), identify the top error, check vendor changelogs under
`docs/f63013c0/vendors`, propose a fix with tests, open a PR, post a root-cause
summary to the alert thread.

## Where things live

- Checkout orchestration + metrics + alerting: `app/services/verticals/f63013c0.js`
- Meridian Pay client adapter: `app/services/verticals/f63013c0-meridian.js`
- Meridian Pay simulator (vendor side): `app/services/verticals/f63013c0-meridian-psp.js`
- Orders store: `app/services/verticals/f63013c0-orders.js`
- HTTP routes (storefront API + `/api/f63013c0/psp` vendor API + `/api/f63013c0/demo/*` controls): `app/routes/verticals/f63013c0.js`
- Metrics endpoint: `GET /api/f63013c0/metrics`
- Reconciliation script: `scripts/f63013c0-reconcile-authorizations.js`
- Tests: `tests/f63013c0-*.test.js`

## After deploy

Run the reconciliation script to complete stranded orders and void duplicate
authorizations, then post its summary to the alert thread:

```bash
node scripts/f63013c0-reconcile-authorizations.js --base-url https://devindemos.com
```

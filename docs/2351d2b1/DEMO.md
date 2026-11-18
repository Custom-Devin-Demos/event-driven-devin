# Carrefour standalone checkout demo (2351d2b1)

- URL: https://devindemos.com/carrefour (also `/2351d2b1`). Separate from the shared
  `f63013c0` storefront and its `/f63013c0/rb/carrefour` skin: own page, API
  (`/api/2351d2b1/*`), service (`carrefour-checkout-service`), metrics and alert suppression.
- Flow: Panier → Commander → Carte bancaire → **Payer ma commande** → payment error
  (HTTP 502 `PAYMENT_FAILED`). Logs show `Missing payment id in PSP response` with
  `brand: Carrefour`. PayPal always succeeds.
- Planted defect (keep it): Meridian Pay API `2026-10` renamed `paymentId` to
  `pspReference`; `2351d2b1-meridian.js` still reads `paymentId`, and no
  `Idempotency-Key` is sent. Boot and `POST /api/2351d2b1/demo/reset` leave the PSP on
  `2026-10`; `POST /api/2351d2b1/demo/unflip` restores the healthy `2025-06` baseline.
- Alert: one Slack alert + Devin session titled "Carrefour — Courses en ligne Checkout"
  per 10 minutes (reset clears the suppression). Credentials reuse the shared
  storefront's customer config (`customer: f63013c0` → `_F63013C0` env vars, else the
  global ones), so no new host env vars are needed. `?reports=off` (or header
  `x-demo-alerts: off`) keeps the failure but skips the alert.

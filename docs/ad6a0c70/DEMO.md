# La Poste standalone checkout demo (ad6a0c70)

- URL: https://devindemos.com/laposte (also `/ad6a0c70`). Cloned from the Carrefour
  demo (`2351d2b1`, `/carrefour`) with a laposte.fr-style storefront: own page, API
  (`/api/ad6a0c70/*`), service (`laposte-checkout-service`), metrics and alert suppression.
- Flow: Panier → Valider mon panier → Carte bancaire → **Payer ma commande** → payment error
  (HTTP 502 `PAYMENT_FAILED`). Logs show `Missing payment id in PSP response` with
  `brand: La Poste`. PayPal always succeeds.
- Planted defect (keep it): Meridian Pay API `2026-10` renamed `paymentId` to
  `pspReference`; `ad6a0c70-meridian.js` still reads `paymentId`, and no
  `Idempotency-Key` is sent. Boot and `POST /api/ad6a0c70/demo/reset` leave the PSP on
  `2026-10`; `POST /api/ad6a0c70/demo/unflip` restores the healthy `2025-06` baseline.
- Alert: one Slack alert + Devin session titled "La Poste — Boutique Checkout"
  per 10 minutes (reset clears the suppression). Credentials reuse the shared
  storefront's customer config (`customer: f63013c0` → `_F63013C0` env vars, else the
  global ones), so no new host env vars are needed. `?reports=off` (or header
  `x-demo-alerts: off`) keeps the failure but skips the alert.

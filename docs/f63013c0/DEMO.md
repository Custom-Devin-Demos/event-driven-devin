# Demo run sheet — Ralph Lauren Digital Flagship Checkout (f63013c0)

Every pane is a **DEMO ENVIRONMENT** with synthetic customers, cards and orders.
Nothing touches Ralph Lauren systems or data.

## URLs

| Pane | URL |
| --- | --- |
| Storefront (Claire's checkout) | `/f63013c0/rb/retail` |

Bare `/f63013c0` serves nothing. APIs live under `/api/f63013c0/…`; the vendor
simulator (Meridian Pay) under `/api/f63013c0/psp/…`.

## Demo controls

```bash
npm run demo:rl -- reset   # orders/auths/metrics cleared; provider stays on 2026-10 (broken)
npm run demo:rl -- start   # provider back to 2025-06, traffic-gen on, flip to 2026-10 armed (--flip-after, default 120s)
npm run demo:rl -- stop    # stop traffic
npm run demo:rl -- flip    # force API 2026-10 now (fallback)
npm run demo:rl -- unflip  # back to healthy 2025-06 (rehearsal only)
npm run demo:rl -- status  # current metrics
```

Or over HTTP: `POST /api/f63013c0/demo/{reset,start,stop,flip,unflip}`.

## Run of show (~8 minutes)

- **−10:00** `demo:reset`, `demo:start`, open the storefront, confirm healthy baseline traffic.
- **0:00** `GET /api/f63013c0/metrics` green, ~8 orders/min — "Monday morning. Claire in Boston is buying a sweater and a gift."
- **0:30** The scheduled flip fires (Meridian Pay ships API `2026-10`). Claire taps **Place order** → "Your payment couldn't be processed." Her card was approved; we failed to record the order.
- **0:45** `GET /api/f63013c0/psp/v1/authorizations?cardToken=tok_claire_visa_4242` shows a pending $568 from RALPH LAUREN.
- **1:00** Claire taps **Try again** → a second pending $568 (no `Idempotency-Key` is sent, so the PSP authorizes again).
- **1:00–1:30** `GET /api/f63013c0/metrics` — success rate collapses; charged-without-order, revenue at risk and chat queue climb. Alert posts once the success-rate rule breaches; Devin's session starts.
- **1:45–4:30** Devin investigates logs, code and `docs/f63013c0/vendors/meridian-pay/CHANGELOG.md`, and posts a root-cause summary.
- **4:30–6:00** PR: accept `pspReference` with fallback, schema-validate the response, send `Idempotency-Key` from the order reference, contract + regression tests. Devin Review checks `docs/f63013c0/ENGINEERING_STANDARDS.md`.
- **6:00** Claire retries → **Order confirmed**. Devin runs `scripts/f63013c0-reconcile-authorizations.js`; charged-without-order and duplicates go to 0.
- **7:00** Pivot: "One vendor changed one field. Same loop, your repos."

## Reset / rehearsal notes

The vendor's auto-upgrade has already shipped, so `demo:reset` clears orders,
authorizations, metrics, alert suppression and chat queue **but leaves the
provider on `2026-10`** — card checkout stays broken, which is the default
state the demo opens in. For a healthy baseline (rehearsal or the traffic
sim's starting point), use `demo:unflip` to revert to `2025-06`. The PayPal
payment method is the alternate success path and always confirms, even on
`2026-10`.

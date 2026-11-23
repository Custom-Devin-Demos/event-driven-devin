# Isracard — Spread a charge into installments assets

Source: https://www.isracard.co.il/ (live page, captured November 23, 2026). The page reproduces the Hebrew/RTL home page (private/business switch, main navigation, hero, quick actions, "הכרטיסים שלנו", loan banner, footer) and a "פריסת חיובים" flow in a mock personal area. White/black layout with rounded black buttons and orange/purple/pink shapes, as on the live site.

| File | Origin |
|------|--------|
| `logo-mark.svg` | Drawn for the mock (not the Isracard logo) |
| `OpenSansHebrew-*.woff2` | Copied from `c5d1587d-assets` (stand-in for the live site's Wix Madefor font) |

No original site scripts, images or analytics are included. The cardholder (דנה כהן, FLY CARD •••• 4417), charges, exchange rates and plan rates are fixtures. All trademarks remain the property of their owners. Unlisted; nothing reaches Isracard.

## Incident flow

1. Open `/isracard` and click **פריסת חיובים** (or go straight to `/isracard#spread`).
2. Keep the pre-selected charge, **CENTARA GRAND BEACH PHUKET ฿38,900** (Thai baht), press **המשך**, keep **12** payments, press **המשך**.
3. Press **לאישור הפריסה**. The API returns HTTP 500 `ISR-INS-4221` / `TypeError: Cannot read properties of undefined (reading 'rate')` and the page shows the failure panel with the plan reference.
4. Pick the Booking.com (EUR), B&H (USD), El Al or KSP (ILS) charge and the same request is approved. The ₪412.40 Shufersal charge is below the ₪500 minimum and cannot be selected.
5. Root cause: THB has no Bank of Israel representative rate; `toBillingAmount` reads `REPRESENTATIVE_RATES[currency]` and never falls back to `CROSS_RATES` (via USD).
6. The service captures Sentry telemetry and invokes the instant alert/session flow (one alert per `ISRACARD_ALERT_COOLDOWN_MS`, default 60 s). `?reports=off` keeps the failure without alerting.

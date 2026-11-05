# FedEx — Shipping Rates on-call demo (`/oncall/c/1960590a`)

## What I built

A recreation of fedex.com's public **Calculate FedEx shipping rates** page (https://www.fedex.com/en-us/online/rating.html), served as the native On-Call skin `1960590a` at `/oncall/c/1960590a`, `/fedex` and `/fedex-rates`. It is unlisted: not on the hub, reachable only by direct URL.

The page was captured from the live site over Chrome CDP: the rendered DOM, the real stylesheets (AEM clientlibs + the rating app's CSS, `@media print` blocks removed), the FedEx Sans web fonts, the logo, the SVG icon sprite and the footer sprites are all self-hosted under `app/public/verticals/1960590a/`. Scripts, `<base>`, CSP/meta tags, the cookie banner and the chat widget were removed. The rate list markup comes from the live results view, so rendered rates look like fedex.com's.

The quote is prefilled: **From** Memphis, TN 38118, United States → **To** Toronto, ON M5V 2T6, Canada; 1 package, 5 lb, 12 × 10 × 8 in, Your Packaging, ship date next business day.

Behind it is the `shippingrates` on-call vertical (`app/services/oncall-verticals/shippingrates.js`): a Memphis-hub ZIP3 zone chart, seven domestic services, an international zone table and per-service list rates with dimensional weight and fuel surcharge.

## The story

The latest rating-web release (`rating-web@2026.11.1`) imported a new international zone table. `INTL_ZONES` has `MX` and `GB` entries but no `CA`, so every US → Canada quote dies in `rateInternational` with:

```
TypeError: Cannot read properties of undefined (reading 'zoneCode')
```

Nothing fails on page load or on a timer — it only happens when the presenter clicks **Show rates** for a Canadian destination.

What happens on that click:

- The page posts to `/api/1960590a/rates`; the on-call shim reroutes it to `POST /api/oncall/shippingrates/rates`, which returns HTTP 500 immediately (latency is normal).
- The page shows FedEx's generic red **"We're sorry, rates are unavailable right now."** message under the button.
- The shim posts `/api/oncall/trigger/shippingrates` (only when `destinationCountry` is `CA`), which posts the "5xx rate — Shipping Rates: Show rates" alert to Slack `#oncall-alerts` and starts the Devin responder session. Devin is told to use "FedEx", "Shipping Rates" and "Show rates" and to cc the fictional on-call engineer as plain text: `cc @Marcus Bell (shipping-rates-oncall)`.

## How to present it

1. Open `/fedex`. This is fedex.com's rate calculator, already filled in for Memphis → Toronto.
2. Show a working quote first: change **To** to `Austin, TX 78701, United States` and click **Show rates**. The page lists First Overnight, Priority Overnight, Standard Overnight, 2Day AM, 2Day, Express Saver and Ground. `Mexico City, CDMX 06600, Mexico` returns International Priority and International Economy.
3. Change **To** back to `Toronto, ON M5V 2T6, Canada` and click **Show rates**. The error appears instantly; switch to Slack and the Devin session.

The expected fix is adding the `CA` zone (and guarding unknown destinations with a clear 4xx), plus a regression test for a US → Canada quote.

## Where things live

- Page: `app/public/verticals/1960590a.html` (assets under `app/public/verticals/1960590a/`)
- Skin: `config/oncall-skins.js` → `1960590a`
- Scenario: `app/services/oncall.js` → `ALERT_SCENARIOS.shippingrates`
- Route: `app/routes/oncall-verticals.js` → `POST /api/oncall/shippingrates/rates`
- Service: `app/services/oncall-verticals/shippingrates.js`
- Tests: `tests/1960590a-oncall-skin.test.js`

## Local testing without real alerts

Start with no credentials (`env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js`), leave `SLACK_ONCALL_ALERTS_CHANNEL_ID` unset, and abort browser requests to `/api/oncall/trigger/**`. Never fire the alert on devindemos.com while setting up.

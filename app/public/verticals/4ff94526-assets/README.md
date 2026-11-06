# Domino's Build Your Own Pizza assets

Source: https://www.dominos.com/menu/build-your-own (live DOM, computed styles and assets captured November 6, 2026).

The builder reproduces the current blue navigation, cream pizza hero, Domino promo, quantity, crust/size cards, sauces, toppings and dipping cups using the original Domino's Sans variable fonts and CMS imagery. Images were converted lossily from PNG to WebP; local copies remove CDN/CORS dependencies. No original site scripts, analytics, customer data or checkout requests are included. `catalog.json` contains the public option names and crust codes extracted from the page. Prices and carryout locations are demo fixtures, not real store quotes.

`sources.json` maps each local asset to its original URL. All trademarks and original assets remain the property of their respective owners. This is an unlisted demonstration, not an ordering service.

## Incident flow

1. Open `/dominos` (alias of `/4ff94526`).
2. Scroll to Crusts and choose **Parmesan Stuffed Crust** (Large).
3. Click **Add To Cart**. The real API returns HTTP 500 / `TypeError: Cannot read properties of undefined (reading 'surcharge')`.
4. The service captures Sentry telemetry and invokes the shared instant alert/session flow. The `alert_path: instant` tag and webhook slug guard prevent a duplicate webhook-triggered session. The prompt tells Devin to investigate, fix the pricing code mismatch and open a PR against `main` without merging/deploying.
5. Choose **Hand Tossed**, then Add To Cart to demonstrate the healthy path. All other crusts work with their supported sizes.

The intentional defect is in `app/services/verticals/4ff94526.js`. Keep it in this demo baseline. The frontend forwards the existing hub identity from localStorage when present; otherwise shared/per-customer server configuration is used. Local verification must run without Sentry/Slack/Devin credentials to avoid starting real sessions.

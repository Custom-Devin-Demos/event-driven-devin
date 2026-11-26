# Renault — Order Twingo E-Tech électrique online assets

Source: https://www.renault.fr/ and the Renault Group article "Ampere: a year of electric revolution at the heart of Renault Group" (November 2026). The page reproduces the renault.fr layout (white header with lowercase navigation and tool icons, full-bleed Twingo hero with tabs, grey E-Tech range cards, key figures, black tiles, newsletter band, black footer) and the renault.fr configurator layout (gallery stage on the left, model/specs/colour/recap panel on the right).

| File | Origin |
|------|--------|
| `logo-mark.svg` | Drawn for the mock (not the Renault logo) |
| Car illustrations | Inline SVG drawn for the mock in `order.js` (no Renault photography) |
| `Montserrat-*.woff2` | Copied from `6566fc71-assets` (stand-in for the NouvelR font) |

No original site scripts, images or analytics are included. Prices, environmental scores, incentives and delivery dates are fixtures. All trademarks remain the property of their owners. Unlisted; nothing reaches Renault.

## Incident flow

1. Open `/renault` and click **commander en ligne** (or go straight to `/renault#configurateur`).
2. Keep the pre-selected **Twingo E-Tech électrique**, press **continuer**, keep Blanc Glacier, press **continuer**.
3. Press **commander et payer l'acompte**. The API returns HTTP 500 `RNO-ORD-5031` / `TypeError: Cannot read properties of undefined (reading 'score')` and the page shows the failure panel with the order reference.
4. Pick Renault 5, Renault 4 or Scenic and the same order is confirmed with the incentive applied.
5. Root cause: the Twingo is not yet on the published ADEME list; `environmentalScore` reads `ADEME_SCORES[model.id]` and never falls back to the manufacturer filing in `PROVISIONAL_SCORES`.
6. The service captures Sentry telemetry and invokes the instant alert/session flow (one alert per `RENAULT_ALERT_COOLDOWN_MS`, default 60 s). `?reports=off` keeps the failure without alerting.

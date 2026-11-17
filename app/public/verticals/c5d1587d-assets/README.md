# Mizrahi-Tefahot — Digital mortgage approval assets

Source: https://www.mizrahi-tefahot.co.il/, https://www.mizrahi-tefahot.co.il/mortgages/ and https://www.mizrahi-tefahot.co.il/mortgages/calculator/ (live DOM, computed styles and assets captured November 17, 2026).

The page reproduces the Hebrew/RTL home page (header, hero, quick actions, cubes, branch locator, footer), the /mortgages landing page and a four-step "אישור משכנתא בדיגיטל" wizard modelled on the mortgage calculator. Brand orange `#ff780b`, slate `#323c4b`; Open Sans Hebrew and logos are served locally, photos hot-link to the live site with Unsplash `onerror` fallbacks.

| File | Original URL |
|------|--------------|
| `logo.svg` | https://www.mizrahi-tefahot.co.il/media/vlwlbdf2/logo.svg |
| `logo-mark.svg` | https://www.mizrahi-tefahot.co.il/images/logo-m.svg |
| `OpenSansHebrew-*.woff2` | https://www.mizrahi-tefahot.co.il/fonts/ |

No original site scripts or analytics are included. The pre-filled borrower (נועה לוי, ID 039337423), rate sheet and mixes are fixtures. All trademarks and original assets remain the property of their owners. Unlisted; no request reaches the bank.

## Incident flow

1. Open `/mizrahi`, click **משכנתאות** → **לקבלת הצעה למשכנתא** (or go straight to `/mizrahi#offer`).
2. Keep the pre-filled answers (first home, ₪2,650,000, Ramat Gan, green-certified building, ₪1,850,000 over 30 years, recommended mix) and press **המשך** through the steps.
3. Press **לקבלת אישור עקרוני**. The API returns HTTP 500 `MTG-PRC-5003` / `TypeError: Cannot read properties of undefined (reading 'baseRate')` and the page shows the pricing-failure panel with the offer reference.
4. Untick the green-building box (or pick a uniform mix) and the same application is approved in principle.
5. The service captures Sentry telemetry and invokes the instant alert/session flow; the prompt asks Devin to fix the missing green CPI-linked pricing row and open a PR without merging.

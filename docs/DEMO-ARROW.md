# Arrow Electronics demo — arrow.com BOM Management → Request for Quote (`c03fbe3d`)

URL: `/arrow` (aliases `/arrow-electronics`, `/arrow-bom`, `/c03fbe3d`). Pick the presenter identity on the hub first so the Devin session lands in your org and the Slack card tags you.

The page follows arrow.com's public BOM Tool, Quote Management and Order Management user guides (header, BOM entry, BOM results grid, Quote Request, quote list). Account, BOMs and prices are fictional.

## Act 1 — Event-driven incident (Sentry → Slack → Devin)

1. BOM Management → **My BOMs** → **MC-4400 Motor Controller Rev C**.
2. Walk the BOM results: matched filters, stock, lead time, price breaks, Tariff Info links, one out-of-stock hot-swap controller.
3. **Quote BOM quantity 1** → Quote Request page → **Submit request for quote** → red "We couldn't submit your request for quote" banner.
4. The `#automated-alerts` card appears and a Devin session starts. Root cause: the BOM contains onsemi `FDMS86180` with country of origin **VN**, and `TARIFF_PROGRAMS` has no Vietnam entry, so `quoteLine` dereferences `undefined` while estimating import duty and the whole quote fails.
5. Contrast: **SH-210 Sensor Hub Rev A** quotes cleanly and shows duty per line; the new quote appears under **Quote**.

Expected fix: handle a country of origin with no tariff program explicitly (quote the line and flag its duty for trade-compliance review, or add the missing program) instead of failing the whole quote, plus a regression test in `tests/c03fbe3d-bom-quote.test.js`.

## Act 2 — AI-led feature development: Supply Risk Insights

The BOM results page has a **Supply Risk Insights** tab (marked NEW) that is a roadmap placeholder. The data is already exposed per line on `GET /api/c03fbe3d/boms/:id` (`lifecycle`, `leadTimeHistory`, `crosses`, `stock`, `countryOfOrigin`).

Suggested prompt (Devin session or Jira/Linear ticket assigned to Devin):

> In COG-GTM/event-driven-devin, build the Supply Risk Insights tab for the Arrow vertical (`app/public/verticals/c03fbe3d.html`, `app/services/verticals/c03fbe3d.js`). Replace the placeholder with: a BOM health summary (lines at risk, longest lead time, share of spend exposed to import duty), and a per-line table with a risk score (High / Medium / Low) derived from lifecycle status, stock versus requested quantity and lead-time trend, an inline SVG sparkline of `leadTimeHistory`, and the recommended crosses with a "Swap in BOM" action. Add a `GET /api/c03fbe3d/boms/:id/risk` endpoint with unit tests. Match the existing arrow.com styling, keep the Submit request for quote incident untouched, open a PR with screenshots.

Lifecycle to narrate: ticket → Devin plans (asks clarifying questions) → implements across API + UI + tests → PR with screenshots → Devin Review → human approves.

## Local testing without real alerts

```bash
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js
```

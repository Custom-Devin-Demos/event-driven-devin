# MyBoeingFleet — Search on-call demo (`/oncall/c/82f029ca`)

## What I built

A recreation of Boeing Global Services' public **MyBoeingFleet** portal page (https://services.boeing.com/operations/myboeingfleet-portal), served as the native On-Call skin `82f029ca` at `/oncall/c/82f029ca`, `/myboeingfleet` and `/mbf-search`. It is unlisted: not on the hub, reachable only by direct URL.

The landing page and the search-results page were captured from the live site over Chrome CDP. The real stylesheet (pruned to the rules the two views use), the Boeing Meso and icon fonts, logos and imagery are self-hosted under `app/public/verticals/82f029ca/`. Angular scripts, the cookie banner and tracking were removed; a small inline script drives the header search.

Behind it is the `fleetsearch` on-call vertical (`app/services/oncall-verticals/fleetsearch.js`):

- Keyword search over 124 real services.boeing.com content items (`fleetsearch-content.json`, harvested from the live search API).
- Part number search over a small parts catalog with nomenclature, ATA chapter, effectivity and Parts Interchangeability (PIR) records.

This is a different flow from the existing MyBoeingFleet spares price & availability skin (`180f1323`).

## The story

Last night's Parts Interchangeability import (`pir-feed@2026.11.05`) added a `ONE_WAY_POST` record for `414T4110-12 → 414T4110-10` (one-way, post-SB 737-21-1203). `INTERCHANGE_CODES` in the `fleet-search@2026.11.2` release has no entry for that code. As a result, every search for that part fails in `interchangeability` with:

```
TypeError: Cannot read properties of undefined (reading 'label')
```

Nothing fails on page load or on a timer. It only fails when the presenter searches that part number.

What happens on that search:

- The page posts `{ query, searchType: 'boeingFleetSearch' }` to `/api/82f029ca/search`. The on-call shim reroutes it to `POST /api/oncall/fleetsearch/search`, which returns HTTP 500 immediately (latency is normal).
- The page shows Boeing's red global message, **"Search is unavailable right now. Please try again later."**, above an empty results view.
- The shim posts `/api/oncall/trigger/fleetsearch` only for the 500 (`alertOnStatus: [500]`). This posts the "5xx rate — MyBoeingFleet Search: part number search" alert to Slack `#oncall-alerts` and starts a Devin session. The session is told to use "MyBoeingFleet", "Search" and "part number", and to cc the fictional on-call engineer as plain text: `cc @Dana Whitfield (fleet-search-oncall)`.

## How to present it

1. Open `/myboeingfleet`. This is Boeing's MyBoeingFleet portal page.
2. Show that search works. Type `airplane health` in the header search and press Enter to get Boeing content results (AHM, Korean Air, Philippine Airlines…). Then search `65C27561-6`; it returns the hydraulic return check valve with its interchangeability.
3. Search `414T4110-12`. The error appears instantly. Switch to Slack `#oncall-alerts` and the Devin thread.

The expected fix adds the missing `ONE_WAY_POST` interchangeability code. Unknown codes should also be handled gracefully instead of failing the whole search, plus a regression test for `414T4110-12`.

## Where things live

- Page: `app/public/verticals/82f029ca.html` (assets under `app/public/verticals/82f029ca/`)
- Skin: `config/oncall-skins.js` → `82f029ca`
- Scenario: `app/services/oncall.js` → `ALERT_SCENARIOS.fleetsearch`
- Route: `app/routes/oncall-verticals.js` → `POST /api/oncall/fleetsearch/search`
- Service: `app/services/oncall-verticals/fleetsearch.js` (+ `fleetsearch-content.json`)
- Tests: `tests/82f029ca-oncall-skin.test.js`

## Local testing without real alerts

Start with no credentials (`env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js`), leave `SLACK_ONCALL_ALERTS_CHANNEL_ID` unset, and abort browser requests to `/api/oncall/trigger/**`. Never fire the alert on devindemos.com while setting up.

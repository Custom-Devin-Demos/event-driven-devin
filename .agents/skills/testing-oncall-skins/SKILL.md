---
name: testing-oncall-skins
description: How to run and verify On-Call customer skins (/oncall/c/<slug>) end-to-end, including the native-page variant, shim rerouting, report portal, and mobile checks.
---

# Testing On-Call Customer Skins

## Server
```bash
PORT=3100 SLACK_ONCALL_ALERTS_CHANNEL_ID=<alerts-ch> SLACK_ONCALL_BUGS_CHANNEL_ID=<bugs-ch> node app/server.js
```
A Slack token must be in env: `SLACK_ONCALL_BOT_TOKEN`, or `SLACK_BOT_TOKEN` as fallback (`app/services/oncall.js` reads `SLACK_ONCALL_BOT_TOKEN || SLACK_BOT_TOKEN`). **Restart after any edit to `config/oncall-skins.js`** (config is loaded at require time). Kill anything already on the port first (`fuser 3100/tcp`).

## What to verify per skin
- `/oncall/c/<slug>`: disclaimer bar is the FIRST body element, page title matches `page.title` (for native pages the shim never rewrites the title — this checks the HTML file's own `<title>`, which must be kept in sync with the config), CTA background equals `theme['--accent']`, no "← All Demos" link (the brand shim removes `.back-link` for every skin, stock or native).
- Submitting the primary action must hit the vertical's on-call endpoint (the shim in the page rewrites the legacy API path): banking → `/api/oncall/banking/transfer`, telco → `/api/oncall/telco/upgrade`, hightech → `/api/oncall/licenses/provision` (not `/api/oncall/hightech/...`), insurance → `/api/oncall/insurance/claim`. It must take ~7–10s (`durationMs` in the JSON server log). The floating "Devin On-Call demo" ribbon shows "Alert posted to #oncall-alerts".
- The Industrials stock page must preserve `quoteForm`, `submitBtn`, `result`, and the site selector element IDs, and its site selector must default to `f3-mesa` in the markup. A custom `page.file` replacing the stock page must reproduce those IDs and the `f3-mesa` default or the degraded-path check silently exercises the healthy path.
- `/oncall/c/<slug>/report`: supportCenter branding; selecting a product pre-fills persona/severity and template text from `bugPortal` config; one submit → one "On-Call bug report posted" log line with the bugs channel id.
- Regression: `/oncall` and `/oncall/report` stay generic (no customer strings); unknown slugs 404; legacy `/` hub and `/<vertical>` pages unchanged (still POST to legacy API path).
- Mobile: emulate width 390 via CDP `Emulation.setDeviceMetricsOverride`; check `document.documentElement.scrollWidth <= 390` and CTA `getBoundingClientRect().height >= 44`. Native skins tend to pass (48px CTA); the shared *stock* vertical pages may render a ~39px CTA — check both surfaces separately and report stock-page shortfalls as cosmetic, not blocking.

## Industrials (mTLS edge) specifics
- `industrials-edge.js` generates cert material with `openssl` at boot (~1.3s after listen). Wait for three `Industrial edge client certificate loaded` log lines before timing the first quote, or you will be timing keygen.
- Expected timings: `f3-mesa` (markup default) ~14.2s and STILL SUCCEEDS green (edge ~2.3s + cloud fallback ~11.9s); `f2-torrance`/`f4-alabama` ~0.31s. An error box on F3 is a failure.
- 14s is invisible in stills: inject a submit-triggered stopwatch overlay via CDP (`#quoteForm` submit listener + MutationObserver on `#result`) so the recording shows measured wall-clock.
- Two-hop causality check: only `service: industrials-edge-gateway` lines may contain `CERT_HAS_EXPIRED` (plus `clientCertSubjectCn`, `clientCertNotAfter`, `site`); the `quote-api` client side must show only `code: ECONNRESET` / `socket hang up`.
- Secrecy check on the client response body: it must contain only `success/quoteId/status/site/factory/estimate` — no `fallback`, `phaseTimings`, `cloudQueueMs`, `cert`, `mtls`, `tls`, `queue`, `k3s`, `eks`. Differing `leadTimeDays` (18 degraded vs 12 healthy) is intentional.
- Legacy `/industrials` (CMMS work-order page) is a different vertical and still throws its planted TypeError; the visible message may read `Cannot read properties of undefined (reading 'rates')` rather than `laborRate` — either wording is the expected planted error, not a regression.

## Browser/CDP gotchas on this box
- Typing into Chrome's URL bar via computer-use keyboard may silently not register. Workaround: navigate with CDP `Page.navigate`.
- The built-in browser_console/read_dom CDP tools may fail with "Could not connect". Launch Chrome yourself with `--remote-debugging-port=9222` and drive CDP via python `websocket-client` (`pip3 install websocket-client`) using `create_connection(url, suppress_origin=True)` — otherwise Chrome 403s the handshake unless `--remote-allow-origins=*` was passed.
- CDP `Emulation.setDeviceMetricsOverride` is reverted when the websocket session closes — keep the connection open while taking OS-level screenshots of the emulated view. Real window resize won't go below ~500px width.
- `lsof` is not installed; use `fuser <port>/tcp`.

## Devin Secrets Needed
`SLACK_ONCALL_BOT_TOKEN` (present). `SLACK_ONCALL_ALERTS_CHANNEL_ID` and `SLACK_ONCALL_BUGS_CHANNEL_ID` may be ABSENT — then alert/bug triggers return `{ok:false,skipped:true}` and log `... channel not configured — skipping ...`. That is clean expected behavior; Slack card rendering simply cannot be verified without those two channel IDs.

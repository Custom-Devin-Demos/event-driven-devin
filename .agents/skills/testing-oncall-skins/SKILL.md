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
- `/oncall/c/<slug>/report`: supportCenter branding; selecting a product pre-fills persona/severity and template text from `bugPortal` config; one submit → one "On-Call bug report posted" log line with the bugs channel id.
- Regression: `/oncall` and `/oncall/report` stay generic (no customer strings); unknown slugs 404; legacy `/` hub and `/<vertical>` pages unchanged (still POST to legacy API path).
- Mobile: emulate width 390 via CDP `Emulation.setDeviceMetricsOverride`; check `document.documentElement.scrollWidth <= 390` and CTA `getBoundingClientRect().height >= 44`.

## Browser/CDP gotchas on this box
- Typing into Chrome's URL bar via computer-use keyboard may silently not register. Workaround: navigate with CDP `Page.navigate`.
- The built-in browser_console/read_dom CDP tools may fail with "Could not connect". Launch Chrome yourself with `--remote-debugging-port=9222` and drive CDP via python `websocket-client` (`pip3 install websocket-client`) using `create_connection(url, suppress_origin=True)` — otherwise Chrome 403s the handshake unless `--remote-allow-origins=*` was passed.
- CDP `Emulation.setDeviceMetricsOverride` is reverted when the websocket session closes — keep the connection open while taking OS-level screenshots of the emulated view. Real window resize won't go below ~500px width.
- `lsof` is not installed; use `fuser <port>/tcp`.

## Devin Secrets Needed
None beyond the Slack env vars above (already provisioned in this environment).

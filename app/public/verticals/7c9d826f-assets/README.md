# Sovos Compliance Network demo (Poland e-invoice)

Layout reference: the public Sovos product documentation for Compliance Network (docs.sovos.com, "Monitor documents" and "Dashboard"; screenshots viewed November 26, 2026): dark navy navigation with the workspace selector, country page with Overview / Cycle / Issued / Received tabs, filter toolbar, documents table and a document detail with History. No Sovos code, scripts or customer data are used. The issuer, buyers, NIPs and invoices are synthetic. The "Send to tax authority" action is a demo stand-in; in the real product documents arrive from the ERP. This is an unlisted demonstration, not a Sovos service. All trademarks belong to their owners.

## Incident flow

1. Open `/sovos-einvoice` (alias of `/7c9d826f`).
2. Select **FV-2026-11-0414** (buyer is a VAT group member) and choose **Send to tax authority**.
3. The API returns HTTP 422 `TAX_AUTHORITY_REJECTED`: the FA(3) document has no `Podmiot2/JST` marker. The page shows the rejection.
4. The service captures Sentry telemetry and invokes the shared instant alert/session flow. The prompt tells Devin to find the root cause and open a PR against `main` without merging.
5. Retries within 60 seconds (`SOVOS_EINVOICE_ALERT_COOLDOWN_MS`) show the rejection again without a second alert.
6. **FV-2026-11-0415** (standard buyer) is authorized: the healthy path.

The intentional defect is `buyerFlags` in `app/services/verticals/7c9d826f.js`: FA(3) requires both buyer markers (`JST`, `GV`, 1 = applies, 2 = does not apply) on every invoice, and the mapper writes only one for VAT-group and local-government buyers. Keep it in the demo baseline, and keep `validateFa3` strict. Local verification must run without Sentry/Slack/Devin credentials to avoid starting real sessions.

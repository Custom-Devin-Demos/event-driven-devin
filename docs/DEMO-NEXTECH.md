# Nextech demo — Practice+ / IntelleChartPRO (`e8947398`)

URL: `/nextech` (aliases `/intellechart`, `/practiceplus`, `/e8947398`). Pick the presenter identity on the hub first so the Devin session lands in your org and the Slack card tags you.

## Act 1 — Event-driven incident (Sentry → Slack → Devin)

1. Check In / Out board → **Arrived** column → **Harold Whitfield** → **Open Chart**.
2. Walk the IntelleChartPRO chart (VA/IOP, OD/OU/OS exam, ICD-10 problem list, superbill with 92014-25, 92133, 92137).
3. Click **Sign & Send to Billing** → red "Charges could not be posted" banner.
4. The `#automated-alerts` card appears and a Devin session starts. Root cause: the 2026 Humana Gold Plus fee schedule (`FEE_SCHEDULES.humana_ma`) has no rate for CPT **92137** (OCT angiography), so `priceCharge` dereferences `undefined`.
5. Contrast: Maria Santos (Medicare B, Eylea injection) and Daniel Brooks (Aetna PPO) sign cleanly.

Expected fix: handle a CPT that is missing from a payer schedule explicitly (hold the line for review / fall back to the practice fee schedule) instead of crashing the whole encounter, plus a regression test in `tests/e8947398-charge-capture.test.js`.

## Act 2 — AI-led feature development: Glaucoma Flowsheet

The chart has a **Glaucoma Flowsheet** tab (marked NEW) that is a roadmap placeholder. Nextech has publicly positioned glaucoma flowsheets as an IntelleChartPRO capability, so this lands well with an ophthalmology audience. The data is already exposed (`iopHistory` on `GET /api/e8947398/patients/:id/chart`).

Suggested prompt (Devin session or Jira/Linear ticket assigned to Devin):

> In COG-GTM/event-driven-devin, build the Glaucoma Flowsheet tab for the Nextech vertical (`app/public/verticals/e8947398.html`, `app/services/verticals/e8947398.js`). Replace the placeholder with: an inline SVG line chart of IOP OD/OS over `iopHistory` with a dashed target-pressure line (target IOP per patient, Harold Whitfield = 18 mmHg), a table of visits that highlights readings above target, and a medication timeline row. Add `targetIop` and `medications` to the patient fixtures and a `GET /api/e8947398/patients/:id/flowsheet` endpoint with unit tests. Match the existing Practice+ styling, keep the Sign & Send to Billing incident untouched, open a PR with screenshots.

Lifecycle to narrate: ticket → Devin plans (asks clarifying questions) → implements across API + UI + tests → PR with screenshots → Devin Review → human approves.

## Local testing without real alerts

```bash
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js
```

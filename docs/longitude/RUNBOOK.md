# LONGITUDE clinic alerts → Teams → Devin

Synthetic web demo modelled on the Lowe's cart demo (`a4c19e72`). The page is a
LONGITUDE clinic site for a fictional clinic. It is not a Boston Scientific
product, uses no real patient or device data, and is connected to no device.

Customer slug: `acee28a2`. Routes: `/longitude`, `/longitude-clinic`, `/bsci`, `/acee28a2`.
Presenter tools (reset, Teams card preview, payload): add `?ops=1`.

## The incident

A clinic nurse presses **Send transmission** for a patient. The service reads the
finding from the transmission and looks up where that alert goes in
`ALERT_ROUTING[model][severity]` (`app/services/verticals/acee28a2.js`).

`SICD-A300`, the device model released a week ago, has a `yellow` route but no
`red` route, so a red alert for that model throws
`TypeError: Cannot read properties of undefined (reading 'worklist')`. The clinic
sees "Transmission received but not processed"; nothing reaches the red alert
worklist and nobody is paged.

| Patient | Model | Finding | Result |
|---|---|---|---|
| Demo Patient A | ICD-VR200 | red | 200, red worklist |
| Demo Patient B | CRTD-400 | yellow | 200, yellow worklist |
| Demo Patient C | SICD-A300 | yellow | 200, yellow worklist (healthy control on the new model) |
| Demo Patient D | SICD-A300 | red | **500, alert fires** |

## Revisions

- Baseline: `devin/longitude-alerts-acee28a2`. The missing route is intentional; keep it.
- Repair PRs target the baseline branch, not `main`, and are never merged.
- Reset worklist clears the page only. It never recalls a Teams message.

## Live path

`failing transmission → Sentry.captureException + createSessionAndAlert → Teams Workflow → eashan-demo channel → Devin automation`

- The card is posted only when `NODE_ENV=production`, Teams is selected on the demo
  hub, and a Teams Workflow URL is set. Anywhere else it is a rehearsal: the card is
  previewed under `?ops=1` and nothing is sent.
- Target: `LONGITUDE_TEAMS_WEBHOOK_URL` if set, otherwise `LOWES_TEAMS_WEBHOOK_URL`
  (the eashan-demo Workflow that is already deployed). No Slack fallback.
- The card carries service `customer-acee28a2-alert-routing`. The Lowe's automation
  matches `customer-a4c19e72-checkout`, so it does not fire on this card. The
  LONGITUDE automation must match `customer-acee28a2-alert-routing`.
- `LONGITUDE_TEAMS_AUTOMATION_URL` sets the card's Watch Devin link.
- One alert per minute; a second press inside the cooldown sends nothing.
- `LONGITUDE_DEMO_DRY_RUN=true` forces rehearsal on the hosted site.

## Safe local startup

```sh
env -i PATH="$PATH" HOME="$HOME" PORT=3011 NODE_ENV=test \
  DD_TRACE_ENABLED=false DD_LOGS_INJECTION=false LONGITUDE_DEMO_DRY_RUN=true \
  node app/server.js
```

## Checks

```sh
npx jest tests/acee28a2-transmissions.test.js tests/verticals-registry.test.js
```

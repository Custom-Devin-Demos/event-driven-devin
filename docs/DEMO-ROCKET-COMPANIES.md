# Rocket Companies — Rocket Mortgage & Redfin savings run sheet

Flow 1 (alert → Slack → Devin → PR) for Shawn Malhotra (CTO, Rocket Companies).
The talk track: *Rocket is joining Redfin home search, Rocket Mortgage lending
and Mr. Cooper servicing into one client journey. The bugs live where those
systems meet. Here a real client hits one, and Devin picks up the alert,
reproduces it, and comes back with a PR ready for review, with nobody steering
each step.*

- Page: `/rocket-companies` (alias `/4e90bb44`). Unlisted, not on the hub. There is no `/rocket` short link.
- Endpoint: `POST /api/rocket-companies/savings/apply` (data: `GET /api/rocket-companies/offer`)
- Service: `app/services/verticals/4e90bb44.js`
- Customer slug: `4e90bb44` (`DEVIN_SERVICE_KEY_4E90BB44`, `DEVIN_USER_ID_4E90BB44`,
  `DEVIN_ORG_ID_4E90BB44`, `ROCKET_SLACK_MEMBER_ID`). Falls back to the shared GTM org;
  alerts and sessions are owned by Mark Porter by default.

## Why this scenario (public facts)

- rocketmortgage.com/redfin (checked 2026-10-12) offers three tiers: **Finance & save**
  (up to $5,000), **Buy, finance & save more** (Redfin/Compass agent, 0.75% lender
  credit up to $6,000) and **Buy, sell & save most** (Redfin agent for both sides:
  the lender credit plus an equal Redfin commission discount, up to $12,000).
  Say "up to $12K". The May 2026 "up to $20K for servicing clients" tier is no
  longer on the live page.
- Rocket closed the Mr. Cooper acquisition on 2025-10-01, and Mr. Cooper servicing
  is being rebranded under Rocket.
- Shawn on the unified platform: "you're the same person coming through the system
  ... I don't have to relearn that now" (HousingWire, Aug 2025).

**Caveat:** the record-format mismatch below is invented for the demo. It is a
plausible integration seam. It is not a claim about how Rocket actually boards
Mr. Cooper loans.

## The scenario

Dana Whitfield (client `RKT-7731`) is buying 4820 Preston Meadow Dr, Frisco TX
($585,000, $117,000 down, $468,000 Rocket loan) and selling 2208 Ridgeview Ln,
Plano TX with Redfin. That puts her on **Buy, sell & save most**: a $3,510 lender
credit plus a $3,510 Redfin commission discount, **$7,020** in total.

Her current loan was boarded from Mr. Cooper on 2026-08-17. Her record still
carries the migrated `servicingTransfer` block and has no `servicing` block.
When she clicks **Apply my savings**:

`applySavings()` → `priceSavings()` → `linkSaleTransaction()` → `currentLoanForSale()`
reads `client.servicing.loanNumber` → `TypeError: Cannot read properties of undefined (reading 'loanNumber')`.

The page lets you switch clients with "Viewing as" (useful to show this is a
targeted bug, not "the site is down"):

| Client | Result |
|---|---|
| Dana Whitfield, RKT-7731, buy + sell, loan boarded from Mr. Cooper (pre-selected) | **Fails**: red "We couldn't apply your savings" panel with a reference ID; alert fires |
| Marcus Lee, RKT-4410, buy + sell, loan originated at Rocket | Applied: $4,800 + $4,800 = $9,600, sale linked to the loan ending 4418 |
| Priya Shah, RKT-2291, buy only | Applied: $2,850 lender credit, no sale link |
| Unknown client id | Handled 400, no alert |

## Run it

1. Open `https://devindemos.com/rocket-companies` (locally: `node app/server.js`,
   `http://localhost:3000/rocket-companies`).
2. Dana is pre-selected: the summary shows the Frisco purchase, the Plano sale, the
   $468,000 loan and **$7,020 of up to $12,000**.
3. Optional: switch "Viewing as" to Marcus Lee, apply (it succeeds), then switch back to Dana.
4. Click **Apply my savings**. The red panel shows "We couldn't apply your savings",
   a reference ID and the TypeError.
5. Behind it: Sentry captures the exception (tags `route`, `tier`, `priorServicer`),
   Datadog records `rocket_redfin_savings.failure`, an alert card posts to Slack, and a
   Devin session is created with `REMEDIATION_DIRECTIVE` appended. The directive is scoped to this route only.
6. Switch to Slack and show the alert card and the Devin session link.
7. In the Devin session, Devin reproduces first at `/rocket-companies?repro=1`, which
   fails identically but raises no Sentry, Slack or Devin event. It records the click and the red panel.
8. Devin resolves the current loan from either record shape (a boarded loan is serviced
   by Rocket under its `boardedLoanNumber`). It turns a buy-and-sell client with no
   loan record into a handled 409 "We couldn't find the loan on the home you're selling",
   records Dana's savings applying ($7,020), and opens a PR with both recordings.

## Safety notes

- `?repro=1` is ignored when `NODE_ENV=production`, so on devindemos.com every click
  on Dana's **Apply my savings** raises a real alert and starts a Devin session. Test locally with
  alerts off (blank `SENTRY_DSN`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `DEVIN_API_KEY`).
- The bug is intentional. Keep it on `main` and close remediation PRs after the demo.
  To re-break after a merged fix, restore `currentLoanForSale` to read only `client.servicing`.

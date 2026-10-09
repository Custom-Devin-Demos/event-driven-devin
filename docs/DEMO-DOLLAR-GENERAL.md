# Dollar General — Same Day Delivery checkout run sheet

Flow 1 (alert → Slack → Devin → PR) for a Dollar General audience. The talk
track is: *a store rollout ships with a config gap, a real shopper hits it, and
Devin picks up the alert, reproduces it, and comes back with a reviewed-ready PR —
nobody steers each step.*

- Page: `/dollar-general` (aliases `/dg`, `/59c53533`) — unlisted, not on the hub
- Endpoint: `POST /api/dollar-general/checkout` (catalog: `GET /api/dollar-general/catalog`)
- Service: `app/services/verticals/59c53533.js`
- Customer slug: `59c53533` (`DEVIN_SERVICE_KEY_59C53533`, `DEVIN_USER_ID_59C53533`,
  `DEVIN_ORG_ID_59C53533`, `DG_SLACK_MEMBER_ID`) — falls back to the shared GTM org,
  alerts and sessions owned by Mark Porter by default

## The scenario

dollargeneral.com leads with **"Same Day Delivery: one free delivery fee with
myDG"**. In the demo, store **#13942** (Nolensville Pike, Nashville) has just been
switched on for Same Day Delivery in the *wave 7* rollout (zone `TN-NASH-07`,
live 2026-10-05), but pricing ops never added a delivery-fee schedule for that
zone.

Jordan, a signed-in myDG member with one free delivery, has a $21.75 cart (Tide,
Gain, Coca-Cola 6-pack, Fruity Pebbles) set to **Delivery** from #13942 and clicks
**Place Order**:

`placeOrder()` → `priceOrder()` → `quoteDelivery()` looks up
`DELIVERY_FEE_SCHEDULES['TN-NASH-07']` → `undefined` → `applyMyDgFreeDelivery()`
→ `TypeError: Cannot read properties of undefined (reading 'baseFee')`.

What still works (good to show it's a targeted rollout bug, not "the site is down"):

| Cart | Result |
|---|---|
| Delivery from #13942 (pre-filled) | **Fails** — red "We couldn't place your order" panel + reference ID, alert fires |
| Store Pickup from #13942 | Order placed, $23.76 |
| Delivery from #08715 (Madison, live since 2025) | Order placed, $6.95 fee waived by myDG |
| Empty cart / bad store / bad item | Handled 400, no alert |

## Run it

1. Open `https://devindemos.com/dollar-general` (locally: `node app/server.js`,
   `http://localhost:3000/dollar-general`).
2. The cart drawer opens pre-filled: 4 items, **Delivery** selected, store
   #13942, "FREE with myDG" delivery, estimated total $23.76.
3. Click **Place Order**. The red panel shows "We couldn't place your order" and
   a reference ID.
4. Behind it: Sentry captures the exception (tags `route`, `storeNumber`,
   `deliveryZone`), Datadog records `dollar_general_checkout.failure`, an alert
   card posts to Slack, and a Devin session is created with `REMEDIATION_DIRECTIVE`
   appended — scoped to this route only.
5. Switch to Slack: show the alert card and the Devin session link.
6. In the Devin session: it reproduces first at `/dollar-general?repro=1`
   (fails identically, but raises no Sentry/Slack/Devin event), recording the
   click and the red panel.
7. Devin adds the `TN-NASH-07` fee schedule, turns a store with no schedule into
   a handled "Same Day Delivery isn't available for this store yet" error, records
   the same checkout succeeding, and opens a PR with both recordings.

Optional beat: before step 3, flip to **Store Pickup**, place the order
successfully, then reload and do step 3 — it shows the bug is specific to the
newly-rolled-out delivery store.

## Resetting after a demo

The planted bug stays on `main`. **Do not merge Devin's fix PR** — close it (or
leave it for review) so the next demo still fails. If a fix does land, restore
`DELIVERY_FEE_SCHEDULES` in `app/services/verticals/59c53533.js` so `TN-NASH-07`
has no entry, and remove any "no schedule" guard in `quoteDelivery`.

# Disney Parks Tickets & Resorts — On-Call run sheet (`/90ccfbb2`)

Silent-revenue-leak incident for the Devin Oncall demo. The guest-facing
storefront never errors; peak dates simply read **Sold Out** while capacity is
still unsold. The page is an unaffiliated replica (banner on top).

## Pieces

| Piece | Where |
|-------|-------|
| Storefront (WDW + Disneyland Resort tickets, Park Pass, resort hotels, cart, checkout) | `app/public/verticals/90ccfbb2.html` |
| Facade + capacity monitor | `app/services/verticals/90ccfbb2.js`, `app/routes/verticals/90ccfbb2.js` |
| Inventory service — Java 8, Spring Boot 2.7 (availability, holds, checkout, `HoldReleaseJob`, audit) | `resort-inventory/` (compose service `resort-inventory`, deploy step 5c) |
| Monitor card | `ALERT_SCENARIOS['90ccfbb2']` in `app/services/oncall.js` → On-Call alerts channel |
| Datadog incident | `declareDatadogIncident` (SEV-2) from the facade |

## The incident (leave it in place)

Commit **"INV-2291: standardize hold TTL configuration on seconds"** changed
`inventory.holds.ttl` from `15` (minutes) to `900` (seconds) and updated
`HoldService.holdTtl()` to `Duration.ofSeconds`, but `HoldReleaseJob.isExpired`
still converts the value with `TimeUnit.MINUTES`. Cart holds therefore expire
for guests after 15 minutes but are only released after 900 minutes (15 h).
`AbandonedCartSimulator` abandons carts on the Thanksgiving-weekend peak dates,
so these dates read SOLD OUT with 8–28% of capacity unsold:

- Magic Kingdom Park — Sat Nov 28
- Disney's Hollywood Studios — Fri Nov 27
- Disneyland Park — Sat Nov 28
- Disney's Grand Floridian Resort & Spa — Thu Nov 26
- Disney's Grand Californian Hotel & Spa — Fri Nov 27

Telemetry the responder can pull: `hold_release.run released=0 … active_holds=74`
(resort-inventory container logs), `Inventory monitor: dates sold out with unsold
capacity` (checkout-api logs, with `holdsPastExpiry`), metrics
`resort_inventory.soldout_with_capacity` and
`resort_inventory.calendar_soldout_impressions`, and
`GET /internal/inventory/audit` on the inventory service.

## Run it

1. Open `https://devindemos.com/90ccfbb2` with the hub identity set.
2. Walt Disney World → Magic Kingdom Park → November: Sat 28 shows **Sold out**.
   Other dates book fine (cart hold timer, `WDPR-…` confirmation).
3. The calendar load fires the monitor: a `[Triggered] Sold out with unsold
   capacity — park & resort inventory` card in #oncall-alerts plus a SEV-2
   Datadog incident (one per 10 minutes, `RESORT_INVENTORY_MONITOR_COOLDOWN_MS`).
4. Devin Oncall picks the card up: pulls logs and metrics, uses DeepWiki on this
   repo to explain the hold/capacity rules (capacity − sold − active holds;
   holds release after their TTL), traces the regression to the INV-2291 commit,
   and opens a PR that fixes `HoldReleaseJob` with a regression test.

Local: `cd resort-inventory && docker run --rm -v "$PWD":/src -v ~/.m2:/root/.m2 -w /src maven:3.8.8-eclipse-temurin-8 mvn -q -B package`,
then `PORT=8085 java -jar target/resort-inventory.jar` and
`RESORT_INVENTORY_URL=http://localhost:8085 node app/server.js`.
Without Slack credentials the card is skipped; the log still shows
`Posting alert and triggering Devin`.

## Close on

- **A human approves the PR** — review is the gate, not the bottleneck.
- **Minutes to RCA** — time from the card landing to Devin's root cause in the
  thread, against the "under 1 hour" target.
- **The win is merged fixes, not tokens.**
- **DeepWiki keeps the context fresh** — the hold/capacity rules come from the
  code as it is today, not a hand-maintained Confluence page.

Do not merge Devin's fix PR into `main`: the regression is the demo.

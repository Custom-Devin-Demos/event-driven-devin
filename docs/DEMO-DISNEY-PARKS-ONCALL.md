# Disney Parks Commerce — On-Call run sheet (`/90ccfbb2`)

One shared inventory provider, two Disney consumers, one contract change that
only one consumer picked up. Click → request → downstream crash → alert. Both
pages are unaffiliated replicas of the Walt Disney World / Disneyland Resort
sites (banner on top).

## Pieces

| Piece | Where |
|-------|-------|
| Provider — `resort-inventory`, Java 8 / Spring Boot 2.7 (catalog, availability, holds, checkout, `HoldReleaseJob`) for tickets, hotels and dining | `resort-inventory/` (compose service `resort-inventory`, deploy step 5c) |
| Legacy ledger posting behind the provider — GnuCOBOL `HLDPOST` | `resort-inventory/cobol/` |
| Consumer A — Tickets & Resort Hotels (`/90ccfbb2`, `/90ccfbb2/tickets`), **on availability v2** | `app/public/verticals/90ccfbb2.html`, `app/services/verticals/90ccfbb2.js` |
| Consumer B — Disney Dining reservations (`/90ccfbb2/dining`), **still on v1** | `app/public/verticals/90ccfbb2/dining.html`, `app/services/verticals/90ccfbb2-dining.js` |
| Monitor card | `ALERT_SCENARIOS['90ccfbb2-dining']` in `app/services/oncall.js` → On-Call alerts channel |

## The incident (leave it in place)

Commit **"INV-2291: availability v2 — price { amount, currency } replaces priceFromUsd"**
changes `AvailabilityService` from

```json
{ "date": "2026-11-21", "status": "LIMITED", "priceFromUsd": 89 }
```

to

```json
{ "date": "2026-11-21", "status": "LIMITED", "price": { "amount": 89, "currency": "USD" } }
```

and migrates the Tickets & Resort Hotels consumer to `price.amount`. Dining's
`quoteReservation` still does `offer.priceFromUsd.toFixed(2)`, so **Book
Reservation** throws `TypeError: Cannot read properties of undefined (reading 'toFixed')`.
The facade answers 500 `RESERVATION_FAILED` with a `DIN-…` reference, captures
to Sentry, declares a SEV-2 Datadog incident and posts the monitor card (once
per restaurant/error per 10 minutes). Dining's own unit tests still pass because
they mock the v1 shape: no consumer-driven contract test ties them to the provider.

Telemetry: `Book Reservation failed` (checkout-api logs, `service:dining-reservations`),
metric `dining_reservations.booking_failure`.

## Run it

1. Open `https://devindemos.com/90ccfbb2/tickets` with the hub identity set →
   **Add Tickets to Cart** → cart → Review & Purchase → `WDPR-…`. The provider works.
2. Open `https://devindemos.com/90ccfbb2/dining` → Be Our Guest is pre-selected →
   **Book Reservation** → "We're sorry… (Reference: DIN-…)".
3. The card lands in #oncall-alerts with a SEV-2 Datadog incident.
4. Devin Oncall pulls logs and metrics, uses DeepWiki to map provider → consumers,
   diffs the availability response against what dining reads, traces it to
   INV-2291, moves dining to `price.amount`, adds a consumer-driven contract test
   that runs against the provider's real response, and opens a PR.

Local: build the jar with `maven:3.8.8-eclipse-temurin-8`,
`cobc -x -free -I resort-inventory/cobol/copy -o /tmp/HLDPOST resort-inventory/cobol/HLDPOST.cbl`, run
`PORT=8085 java -Dinventory.ledger.hldpost=/tmp/HLDPOST -jar resort-inventory/target/resort-inventory.jar`
and `RESORT_INVENTORY_URL=http://localhost:8085 node app/server.js`.

## Close on

- **Consumer-driven contract verification** — the drift he writes about ("APIs drifted out of sync with consumer expectations"), caught in CI next time.
- **A human approves the PR** — review is the gate, not the bottleneck.
- **Minutes to RCA / MTTR** — card landing → root cause in the thread, against "under 1 hour".
- **The win is merged fixes, not tokens.**
- **DeepWiki keeps the context fresh** — the provider/consumer map comes from the code as it is today, not a hand-maintained Confluence page.

Do not merge Devin's fix PR into `main`: the bug is the demo.

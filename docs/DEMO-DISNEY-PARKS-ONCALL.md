# Disney Parks Tickets & Resorts — On-Call run sheet (`/90ccfbb2`)

Click → request → legacy COBOL failure → alert. The page is an unaffiliated
replica of the Walt Disney World / Disneyland Resort booking flow (banner on top).

## Pieces

| Piece | Where |
|-------|-------|
| Storefront (tickets + Park Pass, resort hotels, cart with 15-min hold, checkout) | `app/public/verticals/90ccfbb2.html` |
| Facade + alert path | `app/services/verticals/90ccfbb2.js`, `app/routes/verticals/90ccfbb2.js` |
| Inventory service — Java 8, Spring Boot 2.7 (availability, holds, checkout, `HoldReleaseJob`) | `resort-inventory/` (compose service `resort-inventory`, deploy step 5c) |
| Legacy ledger posting — GnuCOBOL `HLDPOST` (copybooks `HLDREC`/`LEDGREC`, product, season and tax tables) | `resort-inventory/cobol/` (compiled with `cobc` into the container) |
| Monitor card | `ALERT_SCENARIOS['90ccfbb2']` in `app/services/oncall.js` → On-Call alerts channel |

## The incident (leave it in place)

Commit **"INV-2291: add PEAK rate season for Thanksgiving and holiday weeks"**
makes `SeasonCalendar` return `P` for Thanksgiving week and Dec 20 – Jan 1.
`HoldService` passes the season to `LedgerPostingClient`, which runs `HLDPOST`.
HLDPOST's `SEASON-RATE-TABLE` only has `V` and `R` rows, so `SEARCH … AT END`
fires: `HLD0042E NO RATE ENTRY FOR SEASON P`, RETURN-CODE 16. Java answers
500 `LEDGER_POSTING_FAILED`; the facade answers 500 `HOLD_FAILED`, captures to
Sentry, declares a SEV-2 Datadog incident and posts the monitor card.

Telemetry: `ledger.post_failed program=HLDPOST rc=16 … record="…"` (resort-inventory
logs), `Add to cart failed: hold could not be posted` (checkout-api logs),
metric `resort_inventory.hold_failure`.

## Run it

1. Open `https://devindemos.com/90ccfbb2` with the hub identity set.
2. Magic Kingdom Park and Thanksgiving Saturday are pre-selected → **Add Tickets
   to Cart** → error with a reference. Any non-holiday date adds to cart and
   checks out (`WDPR-…`).
3. The card lands in #oncall-alerts with a SEV-2 Datadog incident.
4. Devin Oncall pulls logs and metrics, uses DeepWiki on this repo to explain the
   hold/season/ledger rules, traces the failure from `LedgerPostingClient` into
   `HLDPOST.cbl` and the INV-2291 commit, adds a `P` row (and bumps `OCCURS`),
   proves it with `resort-inventory/cobol/test-hldpost.sh` (GnuCOBOL) plus a
   new peak case, and opens a PR.

Local: `cobc -x -free -I resort-inventory/cobol/copy -o /tmp/HLDPOST resort-inventory/cobol/HLDPOST.cbl`,
build the jar with `maven:3.8.8-eclipse-temurin-8`, run
`PORT=8085 java -Dinventory.ledger.hldpost=/tmp/HLDPOST -jar resort-inventory/target/resort-inventory.jar`
and `RESORT_INVENTORY_URL=http://localhost:8085 node app/server.js`.

## Close on

- **A human approves the PR** — review is the gate, not the bottleneck.
- **Minutes to RCA** — card landing → root cause in the thread, against "under 1 hour".
- **The win is merged fixes, not tokens.**
- **DeepWiki keeps the context fresh** — the COBOL rate rules come from the code as it is today, not a hand-maintained Confluence page.

Do not merge Devin's fix PR into `main`: the bug is the demo.

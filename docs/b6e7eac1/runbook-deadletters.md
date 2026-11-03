# Runbook — `converge-rentalsync-deadletter-count` (Sev2)

**Signal:** Azure Monitor metric alert on `DeadletteredMessages > 0` for the `converge-rentalsync` subscription of the `catrentals-returns` topic (15-minute window).

**Business impact:** each dead-lettered message is a machine that has physically come back to a dealer yard but is still `OnRent` in Cat Converge (D365 F&O). The customer keeps being billed and the unit cannot be re-rented. Dealer-facing SLA: resolve within 4 business hours.

## Steps

1. **Acknowledge** in the owning team's Microsoft Teams channel: rule, severity, how many messages, which dealers/contracts.
2. **Reproduce**: clone the repo, `npm ci`, `npx jest tests/b6e7eac1-deadletter-triage.test.js`, start the service (`PORT=5000 node app/server.js`), `GET /api/b6e7eac1/deadletters`. Each record has `errorCode`, `reason` and the full `body`.
3. **Classify each message** (one sentence, name the owner):
   - `WAREHOUSE_UNMAPPED` → a return yard is missing from the branch→warehouse map for that legal entity. *Owner: this team* (KI-12). Fix: add the mapping in `app/services/verticals/b6e7eac1-seed.js` + test.
   - `DEALER_UNKNOWN` → the dealer code on the event is not in the directory, usually a country-suffixed code. *Owner: this team* (KI-11). Fix: add alias support/entries + test.
   - `CONTRACT_NOT_FOUND` / `CONTRACT_NOT_ON_RENT` → F&O data issue or duplicate event. *Owner: dealer / D365 configuration*. Do not change code; report.
   - Values outside physical range in the body (fuel > 100%, negative hours) → *Owner: Cat Rentals*. Flag it (KI-07); do not alter the mapper's behaviour in the incident PR.
4. **Fix** what this team owns, minimally, with a regression test per fix. `npx jest tests/b6e7eac1-catsec-gate.test.js` and `npx jest tests/b6e7eac1-deadletter-triage.test.js` must pass.
5. **Open one PR** on `devin/deadletter-triage-<timestamp>` describing cause, fix and anything flagged to other owners. Do not merge.
6. **Replay** each message with `POST /api/b6e7eac1/deadletters/{eventId}/replay` against a service running the fixed code. `200` = applied (line now `Returned`); `409` = still failing (read the new reason).
7. **Report** in the same Teams thread: per message — applied or still parked, and why.

## What this environment simulates
Azure Monitor, Service Bus and D365 are stand-ins inside this service. In the production estate the same steps read App Insights / Log Analytics, the real DLQ and F&O via OData with read-only service principals.

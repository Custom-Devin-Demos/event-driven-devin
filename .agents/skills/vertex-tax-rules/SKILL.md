---
name: vertex-tax-rules
description: Team conventions for tax-rule changes in the Vertex vertical (513ad458) — rate changes, new jurisdictions, fixtures, seed book. Use for any Vertex tax-rate or jurisdiction ticket.
---

# Vertex tax-rule change conventions

Owner: Tax Platform team. These apply to every change to rates or jurisdictions in the Vertex vertical.

## Before editing
1. Post a plan first: every file you will read and change, and why. No edits until the plan is posted.
2. Read the source of truth — `JURISDICTIONS` in `app/services/verticals/513ad458.js` — plus `tests/fixtures/513ad458-tax-fixtures.json`, `config/seeds/513ad458-accounts.json` and the `tests/513ad458-*.test.js` suites.

## Making the change
3. Rates are decimals (`0.14`, not `14`), one authority row per tax. Money is rounded per authority line to cents with `roundMoney`; compare rates with `toBeCloseTo`, never `===`.
4. A rate change always ships together with: the rate row, the golden fixture for that jurisdiction, the seed book, and tests. The seed book and the fixture set must never drift: every jurisdiction that appears in the seed book needs a golden fixture.
5. If the ticket asks for a seed account, add a realistic account with at least one invoice dated inside the effective window, so the invoice register shows the new rate.
6. Out of scope for rate tickets: `TAXABILITY_MATRIX`, `resolveTaxability` and `calculateTax` (owned by the tax-determination team), and `legacy/vertex-report-engine` (hand-maintained copy of the rules — do not edit it in a rate ticket; call out the drift under "Known drift" in the PR description instead).

## Verify
7. `npx jest tests/513ad458-` (seconds) and `npx eslint app/services/verticals/513ad458*.js app/routes/verticals/513ad458.js`.
8. Run the app (`PORT=3100 node app/server.js`), open `http://localhost:3100/vertex/dashboard/billing`, and screenshot the invoice for the affected jurisdiction showing the new tax line.

## Pull request
9. Branch `devin/<ticket-key-lowercase>-<slug>`; commits prefixed `feature:` or `bug:`.
10. PR description: ticket key and link in the first line; a "Files changed" table (file, what changed, why); test command and output; the billing screenshot; a "Known drift" section.

# DEMO.md — Peak-season store pickup incident (b8d844e5)

Presenter: Ian Hodge. Audience: Jason Morris, CTIO. Length: 12–15 min (60-min extension at the end).

Stack shown: Java 21 + Spring Boot 3.3 + Spring Kafka, Kafka (KRaft), Docker Compose (Kubernetes-ready images), GitHub + GitHub Actions, React storefront. All data is synthetic; no real orders.

| Piece | Where |
|---|---|
| Storefront (local) | http://localhost:8080/ (`?ops=1` or Alt+. opens the presenter drawer; `?reports=off` never pages) |
| Storefront (hosted, once deployed) | https://devindemos.com/b8d844e5/ |
| Service code | [COG-GTM/inventory-availability-service](https://github.com/COG-GTM/inventory-availability-service) (local clone: `~/repos/inventory-availability-service`) |
| Alert bridge | `POST /api/b8d844e5/incident` in checkout-api → Slack `#oncall-alerts` + Devin session |
| Planted defect | `StoreStockProjection.apply()` has no rule for `RETURN_RESTOCKED`; the unlimited-retry error handler parks the Seattle partition behind it. Kept on `main`. |

## Before the meeting (10 min)

1. `cd inventory-availability-service && docker compose down -v && docker compose up -d --build`, wait ~40 s.
2. Check the defect is live: `curl -s 'localhost:8081/api/inventory/ops/store-stock?storeId=store-0001&sku=402771-HGRY-M'` → `posOnHand: 5`, `available: 0`, `stall.eventType: RETURN_RESTOCKED`.
3. For a live alert, run checkout-api with Slack/Devin credentials and start the inventory service with `ONCALL_INCIDENT_URL=http://host.docker.internal:3000/api/b8d844e5/incident` (hosted: already wired). Set your identity once in the browser console so the session lands in your account: `localStorage.devinEmail='ian.hodge@cognition.ai'`.
4. Open Slack `#oncall-alerts`, the storefront, and Devin in three tabs.

## Run sheet

| # | Say | Do |
|---|---|---|
| 1 | "Black Friday, 6 pm. A shopper in Seattle wants this sweater for pickup tonight." | Storefront → Heather Grey, M → Order Pickup → Nordstrom Downtown Seattle. |
| 2 | "The store has five on the shelf. We tell her it's sold out." | **Place order** → red "Sorry, we couldn't place your order". Alt+. shows POS 5 vs availability 0, partition 1 stuck on `RETURN_RESTOCKED`. |
| 3 | "You've run this war room. Nobody is reading consumer lag at 6 pm on Black Friday." | Slack `#oncall-alerts`: card with store, SKU, POS vs service, partition, offset, retries, plus the Devin session link. |
| 4 | "Devin reads the service the way a new engineer would — DeepWiki first, then the code." | Open the session: DeepWiki question, `docker compose up` with Kafka on its own machine, curl reproduces the 409 and the stalled offset. |
| 5 | "It finds the return event the projection never learned, fixes it, and proves it with a Kafka test — not a skip or a dead-letter hack." | Show the diff (`RETURN_RESTOCKED` handled, idempotent by `eventId`) and the new unit + embedded-Kafka tests. |
| 6 | "Normal pull request. Your CI, your reviewers. Devin Review comments too." | PR → GitHub Actions green → Devin Review comments. Nobody merges live. |
| 7 | "And the proof that matters to the shopper." | Devin's browser: same store, **Place order** → "Ready for pickup at Nordstrom Downtown Seattle". |
| 8 | "That session was started by one API call — that's what your PDLC platform would do." | Show the `POST /v3/organizations/{org}/sessions` call in the bridge (`app/services/verticals/b8d844e5.js`). Devin is the worker your PDLC Agents Platform dispatches; you keep the routing, policy and audit. |

Who merges and deploys: the service owner reviews and merges the PR; the hosted stack redeploys from `main` via the existing event-driven-devin deploy workflow. Devin never merges.

## Objections

- *"We're building our own agent platform."* — Good: keep it. This is one API call from it; Devin brings the sandboxed machine, the tooling and the review loop.
- *"Would it just skip the bad record?"* — The repo's AGENTS.md forbids weakening the error handler; review would catch it, and the test proves the stock is right.
- *"Security?"* — Runs in our VPC or yours, scoped repo access, every change is a PR.

## 60-min extension

Ask Devin to fan out: one child session per sibling consumer (e.g. fulfillment, price) to check for unhandled event types with the same pattern and open one PR each.

## Reset (2 min)

1. Close (don't merge) any fix PR; delete its branch.
2. `cd inventory-availability-service && docker compose down -v && docker compose up -d --build` (hosted: redeploy `main`). The topic and projection rebuild from the seed with the defect.
3. Alert dedupe clears after 10 min, or restart checkout-api.
4. Re-run step 2 of "Before the meeting".

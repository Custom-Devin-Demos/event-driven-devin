# AGENTS.md — Guide for AI Software Engineering Agents

This document describes the **Event-Driven Devin** demo repository for AI agents that are asked to investigate, fix, or extend the codebase.

## What This Repo Is

A Node.js/Express application with integrated observability (Sentry + Datadog) and automated incident response (Slack alerts + Devin). The app serves **10 industry vertical demos**, each with its own frontend, API routes, and business logic. Each vertical has a production bug that produces a `TypeError` when its primary action is triggered. When an error occurs, the system automatically posts an alert to Slack and triggers a Devin session to investigate and fix it.

## Industry Verticals

The app hosts 10 verticals, each accessible at its own URL:

| Vertical | URL Path | Frontend | API Endpoint | Service File |
|----------|----------|----------|--------------|-------------|
| **Hub** (landing page) | `/` | `app/public/hub.html` | — | — |
| **Retail eCommerce** | `/retail` | `app/public/index.html` | `POST /api/storefront/checkout` | `app/routes/storefront.js` |
| **Banking** | `/banking` | `app/public/verticals/banking.html` | `POST /api/banking/transfer` | `app/services/verticals/banking.js` |
| **Financial Services** | `/financial-services` | `app/public/verticals/financial-services.html` | `POST /api/trading/execute` | `app/services/verticals/financial-services.js` |
| **Insurance** | `/insurance` | `app/public/verticals/insurance.html` | `POST /api/insurance/claim` | `app/services/verticals/insurance.js` |
| **CPG** | `/cpg` | `app/public/verticals/cpg.html` | `POST /api/cpg/order` | `app/services/verticals/cpg.js` |
| **High Tech** | `/hightech` | `app/public/verticals/hightech.html` | `POST /api/licenses/provision` | `app/services/verticals/hightech.js` |
| **Industrials** | `/industrials` | `app/public/verticals/industrials.html` | `POST /api/maintenance/workorder` | `app/services/verticals/industrials.js` |
| **Healthcare** | `/healthcare` | `app/public/verticals/healthcare.html` | `POST /api/healthcare/appointment` | `app/services/verticals/healthcare.js` |
| **Telco** | `/telco` | `app/public/verticals/telco.html` | `POST /api/telco/upgrade` | `app/services/verticals/telco.js` |
| **Payer** (unlisted — direct URL only) | `/payer`, `/welcome-season` | `app/public/verticals/payer.html` | `POST /api/payer/pharmacy-claim` | `app/services/verticals/payer.js` |
| **QBE North America Claims** (unlisted — direct URL only) | `/qbe` | `app/public/verticals/qbe.html` | `POST /api/qbe/claim` | `app/services/verticals/qbe.js` |
| **HCF Extras Claims** (unlisted — direct URL only) | `/hcf` | `app/public/verticals/hcf.html` | `POST /api/hcf/claim` | `app/services/verticals/hcf.js` |
| **Suncorp Bank Payments** (unlisted — direct URL only) | `/suncorp` | `app/public/verticals/suncorp.html` | `POST /api/suncorp/payment` | `app/services/verticals/suncorp.js` |
| **Insignia Financial Super Allocation** (unlisted — direct URL only) | `/insignia` | `app/public/verticals/insignia.html` | `POST /api/insignia/allocation` | `app/services/verticals/insignia.js` |
| **HUB24 Adviser Fee Arrangement** (unlisted — direct URL only) | `/hub24` | `app/public/verticals/hub24.html` | `POST /api/hub24/fee-arrangement` | `app/services/verticals/hub24.js` |
| **CFS Lump Sum Withdrawal** (unlisted — direct URL only) | `/cfs` | `app/public/verticals/cfs.html` | `POST /api/cfs/withdrawal` | `app/services/verticals/cfs.js` |
| **NRMA Insurance Home Claim** (unlisted — direct URL only) | `/nrma`, `/iag` | `app/public/verticals/nrma.html` | `POST /api/nrma/claim` | `app/services/verticals/nrma.js` |
| **NAB Internet Banking** (unlisted — direct URL only) | `/nab` | `app/public/verticals/nab.html` | `POST /api/nab/payment` | `app/services/verticals/nab.js` |
| **CommBank NetBank — Pay anyone** (unlisted — direct URL only) | `/cba`, `/commbank`, `/netbank` | `app/public/verticals/cba.html` | `POST /api/cba/payment` | `app/services/verticals/cba.js` |
| **Macquarie Online Banking** (unlisted — direct URL only) | `/macbank` | `app/public/verticals/macbank.html` | `POST /api/banking/transfer` (shared with Banking) | `app/services/verticals/banking.js` |
| **Databricks Compute / Spark UI** (unlisted — direct URL only) | `/databricks`, `/0b6164d6` | `app/public/verticals/0b6164d6.html` | `POST /api/0b6164d6/cluster-ui` | `app/services/verticals/0b6164d6.js` |
| **Morgan Stanley Wealth Management** (unlisted — direct URL only) | `/morganstanley`, `/c7d11cb8` | `app/public/verticals/c7d11cb8.html` | `POST /api/c7d11cb8/rebalance` | `app/services/verticals/c7d11cb8.js` |
| **Ping Identity — PingOne Environment Provisioning** (unlisted — direct URL only) | `/pingidentity`, `/81deeb2e` | `app/public/verticals/81deeb2e.html` | `POST /api/81deeb2e/environments` | `app/services/verticals/81deeb2e.js` |
| **Carvana — Checkout & Financing** (unlisted — direct URL only) | `/carvana`, `/fd7f4e04` | `app/public/verticals/fd7f4e04.html` | `POST /api/fd7f4e04/orders` | `app/services/verticals/fd7f4e04.js` |
| **Aravia Therapeutics — Patient Access Portal** (fictional brand, unlisted — direct URL only) | `/patient-access`, `/fcf0f903` | `app/public/verticals/fcf0f903.html` | `POST /api/fcf0f903/enrollment`, `POST /api/fcf0f903/copay-estimate` | `app/services/verticals/fcf0f903.js` |
| **Zuora — AI Usage-Based Pricing** (unlisted — direct URL only) | `/zuora`, `/ce4ebc10` | `app/public/verticals/ce4ebc10.html` | `POST /api/ce4ebc10/publish-pricing` | `app/services/verticals/ce4ebc10.js` |
| **Rippling — Payroll Run** (unlisted — direct URL only) | `/rippling`, `/a7fb8819` | `app/public/verticals/a7fb8819.html` | `POST /api/a7fb8819/submit-pay-run` | `app/services/verticals/a7fb8819.js` |
| **Gusto — Payroll Ops On-Call Console** (unlisted — direct URL only) | `/gusto`, `/f8555891` | `app/public/verticals/f8555891.html` | `POST /api/f8555891/release-batch` (failure → monitor card in the on-call alerts channel, no app-created Devin session), `POST /api/f8555891/support-ticket` (customer report → on-call bugs channel; with `split`, one parent ticket `GUS-####` plus threaded sub-tickets `GUS-####.N`) | `app/services/verticals/f8555891.js` |
| **Tax Revenue Portal — Pay Taxes** (generic demo brand, unlisted — direct URL only) | `/tax-portal`, `/3640b94c` | `app/public/verticals/3640b94c.html` | `POST /api/3640b94c/payment` | `app/services/verticals/3640b94c.js` |
| **FPL My Account — NextEra Energy** (Flutter app, unlisted — direct URL only) | `/fpl`, `/nextera`, `/b425648c` (landing), `/b425648c/app` (app) | `app/public/verticals/b425648c.html`, `app/public/verticals/b425648c-app/` | `POST /api/b425648c/mobile/error`, `POST /api/b425648c/outage/report` | `app/services/verticals/b425648c.js` |
| **BNY NEXEN — Digital Asset Custody** (Vite/React app, unlisted — direct URL only) | `/bny`, `/nexen`, `/9bfabd45` (all redirect), `/9bfabd45/app` (app) | `app/public/verticals/9bfabd45-app/` | `POST /api/9bfabd45/error` | `app/services/verticals/9bfabd45.js` |
| **State Street — Client Banking Portal** (unlisted — direct URL only) | `/statestreet`, `/4da81799` | `app/public/verticals/4da81799.html` | `POST /api/4da81799/transfer` | `app/services/verticals/4da81799.js` |
| **Fleet Health Console — Engine Health Pipeline** (unlisted — direct URL only) | `/fleet-health`, `/a693dab5` | `app/public/verticals/a693dab5.html` | `GET /api/a693dab5/fleet`, `GET /api/a693dab5/runs`, `POST /api/a693dab5/runs` | `app/services/verticals/a693dab5.js` |

Each vertical follows the same flow: **User action → Bug triggers → Sentry/Datadog capture → Slack alert → Devin investigates → PR created**.

### On-call vertical slice (Flows 1–2)

Separate from the legacy verticals above, the On-Call demo (`/oncall`) serves the same branded pages in on-call mode with their primary action rerouted (via an injected fetch shim in `app/routes/oncall.js`) to a parallel set of endpoints backed by copied services carrying performance-degradation bugs instead of TypeErrors:

| Vertical | On-call API Endpoint | Service File |
|----------|---------------------|--------------|
| Banking | `POST /api/oncall/banking/transfer` | `app/services/oncall-verticals/banking.js` |
| Telco | `POST /api/oncall/telco/upgrade` | `app/services/oncall-verticals/telco.js` |
| High Tech | `POST /api/oncall/licenses/provision` | `app/services/oncall-verticals/hightech.js` |
| Insurance | `POST /api/oncall/insurance/claim` | `app/services/oncall-verticals/insurance.js` |
| Industrials | `POST /api/oncall/industrials/quote` | `app/services/oncall-verticals/industrials.js` |
| Marketplace | `POST /api/oncall/marketplace/cart` | `app/services/oncall-verticals/marketplace.js` |
| Voice | `POST /api/oncall/voice/transcribe` | `app/services/oncall-verticals/voice.js` |
| Samsara Fleet (native iOS/macOS app) | `POST /api/oncall/26a3d261/eta-failure` | `app/services/oncall-verticals/fleet.js` |
| Partiful RSVP (native iOS/macOS app + `/partiful` web replica) | `POST /api/oncall/205bc15f/rsvp-page-failure` | `app/services/oncall-verticals/partiful.js` |

Routes are mounted from `app/routes/oncall-verticals.js`, except the two native-app report endpoints, which live in `app/routes/oncall.js`. The degradations are deliberately not described here — the on-call demo's premise is that the responder diagnoses them from telemetry. The legacy `/api/<vertical>/...` endpoints and their planted TypeErrors are untouched.

**Voice fixes require real-audio verification.** Any fix touching the voice transcribe path (`app/services/oncall-verticals/voice.js` or `POST /api/oncall/voice/transcribe`) must be verified with real audio, not typed input: follow the "Voice (dictation) specifics" section of `.agents/skills/testing-oncall-skins/SKILL.md` — piper TTS speaks the utterance, ffplay plays it in a visible terminal, whisper.cpp transcribes it live, and the transcript finalizes on the page with the latency stopwatch on screen. Record 2–3 finalizes before and after the fix to show the climbing latency and the flat fast profile.

Customer skins receive the alerts surface by default. Optional `bugPortal` and `incident` skin config entries opt into `/oncall/c/:slug/report` and `/oncall/c/:slug/incident` respectively.

**On-call (`/oncall`) cards never route to a real person.** Their *Owner* field is a scenario persona (`OWNER_DISCLAIMER` in `app/services/slack.js`) and the only real mention on an on-call card is *Triggered by*, resolved from the `devinEmail` the run supplied. A responder that cannot resolve the persona must @-mention nobody in its place — do not fall back to `git blame`, commit authors, or CODEOWNERS to find someone to cc, since every file here was last touched by whoever built the demo, not by whoever is on call.

**Customer-vertical alert cards (`postAlertToSlack`) name a real owner or nobody — never a made-up one.** The *On-Call* field is `onCallText()`: the `slackMemberId` the vertical passed to `createSessionAndAlert`, else the member resolved from `devinEmail`, else `slackMemberIdFallback`, else the opt-in `DEMO_ONCALL_SLACK_MEMBER_ID`, else `_Unassigned_` (`ONCALL_UNASSIGNED_TEXT`) with no @-mention. Every custom demo vertical passes `slackMemberId` explicitly — Russell unless the person who commissioned the demo named someone else — and the Devin session is created as that same person (`devinUserId`), so Slack and Devin agree on who owns the incident. A fictional name in that field reads to the audience as a real teammate, which is why the persona fallback was removed from this path; do not reintroduce one.

### Payer welcome-season scenario

The payer vertical models a plan-configuration defect rather than an infrastructure failure: `PLAN_CONFIGS` carries a 7-digit `rxBin` (`0044336` instead of `004336`) for two plans, `generateMemberIdCard()` copies it onto member ID cards unvalidated, and `adjudicateClaim()` then finds no `PAYER_REGISTRY` entry for that BIN. Every service stays healthy — the only signal is the `pharmacy_claim.rejected` business metric.

The page is not listed in the `VERTICALS` array in `app/routes/verticals/index.js`, so it does not appear on the hub: it is plan-branded and the hub is on screen during customer demos. Reach it at `/welcome-season`.

Two things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live (add routing validation before a card is issued). Set both NC State Health Plan `rxBin` values to `004336` to run the demo pre-fixed.
- **`scripts/welcome-season-sweep.js` is the prevention control** — it validates every Jan-1 plan config and submits synthetic claims, exiting non-zero before cards mail. It owns its own `validateRxRouting()` because the service intentionally has none yet.

`FANOUT_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`, instructing the triage session to split remediation across four parallel child sessions. See `docs/DEMO-WELCOME-SEASON.md` for the run sheet and `docs/WIKI-PAYER-WELCOME-SEASON.md` for the full reference.

### Gusto ticket-swarm scenario

The Gusto vertical (`/gusto`, slug `f8555891`) is the multi-agent demo. The planted defect is a payroll batch that fails because Minnesota has no entry in `STATE_PAYROLL_PROGRAMS`; the release failure posts a monitor card to the on-call alerts channel and deliberately creates no Devin session. The agents enter through the **support side**: a multi-symptom customer report filed with `split` becomes one parent ticket (`GUS-1041`) in the on-call bugs channel with each symptom threaded under it as a numbered sub-ticket (`GUS-1041.1`, `.2`, …). `postOncallBugReport` accepts `threadTs` / `ticketId` / `parentTicketId` for this; single-symptom reports stay flat.

The parent card tells the responder to @Devin `swarm this ticket`. That session follows `.devin/skills/gusto-ticket-swarm/SKILL.md`, which runs `.devin/skills/gusto-ticket-swarm/workflow.py`: one read-only investigator child per sub-ticket in parallel → one consolidator that dedupes findings into root-cause groups → one fixer per group that opens a single PR (tests, lint, browser recording; never merges). The prompts live in that `workflow.py` so a customer can edit agent behaviour live. **Leave the MN defect in place** and do not merge swarm PRs — the failure is the demo. See `docs/DEMO-GUSTO-ONCALL.md` for the run sheet.

### Kroger feature-encoding scenario

The Kroger vertical (`/kroger`, slug `eaa595e1`) plants **one encoding gap with two symptoms**, aimed at a data-science audience. The annual-billing rollout added a `boost-annual` tier mapped to the `boost_annual` program code, but that code was never registered in two separate places:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `computeFuelPoints()` | Dereferences the missing `FUEL_POINT_PROGRAMS` entry and throws | `TypeError` → Sentry → Slack → Devin session |
| `rankOffers()` | Finds no vector in the offer-affinity feature view, scores every offer 0, serves the unranked pool | HTTP 200. Only `personalization.offer_match_rate` dropping to 0 |

The silent half is the point: models do not crash when they break, they quietly get worse.

**The defect originates in the pipeline, not the route.** `pipelines/kroger/offer-affinity-spec.json` is the source of truth for segment encoding; `pipelines/kroger/build-offer-features.js` materializes it into `app/services/verticals/features/eaa595e1-offer-affinity.json`, which the service loads at require time. A tier declared in `membershipTiers` with no entry under `segments` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add a `boost_annual` segment to the spec, run `npm run features:build`, and add a `boost_annual` entry to `FUEL_POINT_PROGRAMS`. The service `require`s the built artifact, so Node caches it at startup — **restart the server after a rebuild**, or the storefront keeps serving the degraded state.
- **`scripts/kroger-personalization-audit.js` is the prevention control** (`npm run audit:kroger`) — it scores every tier the *service* can serve through the real ranker and exits non-zero when a tier is undeclared in the spec, mapped inconsistently between spec and service, absent from the feature view, or encoded but scoring nothing. It is not wired into the build, which is why the gap reached production.
- **`npm run features:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte, so a hand-edited artifact does not pass.

`SECOND_ORDER_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`. It sends the session to the audit first, then to the spec and the build's missing coverage gate — explicitly instructing it to fix the data problem rather than patch the crash site. Regression coverage for both paths lives in `tests/kroger-offer-affinity.test.js`.

### Gap style-encoding scenario

The Gap data-intelligence vertical (`/gapdata`, slug `383b99d1`) plants **one encoding gap with two symptoms**, aimed at a data-intelligence audience. It is separate from the original Gap checkout vertical (`/43f2f084`), which keeps its receipt-formatting TypeError. The Good Rewards relaunch added an `icon` tier mapped to the `gr_icon` program code, but that code was never registered in two separate places:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `computeRewardsPoints()` | Dereferences the missing `REWARDS_POINT_PROGRAMS` entry and throws | `TypeError` → Sentry → Slack → Devin session |
| `rankOffers()` | Finds no vector in the style-affinity feature view, scores every offer 0, serves the unranked pool | HTTP 200. Only `personalization.offer_match_rate` dropping to 0 |

**The defect originates in the pipeline, not the route.** `pipelines/gap/style-affinity-spec.json` is the source of truth for segment encoding; `pipelines/gap/build-style-features.js` materializes it into `app/services/verticals/features/383b99d1-style-affinity.json`, which the service loads at require time. A tier declared in `membershipTiers` with no entry under `segments` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add a `gr_icon` segment to the spec, run `npm run style:build`, and add a `gr_icon` entry to `REWARDS_POINT_PROGRAMS`. The service `require`s the built artifact, so **restart the server after a rebuild**.
- **`scripts/gap-personalization-audit.js` is the prevention control** (`npm run audit:gap`) — it scores every tier the *service* can serve through the real ranker and exits non-zero when a tier is undeclared in the spec, mapped inconsistently between spec and service, absent from the feature view, or encoded but scoring nothing. It is not wired into the build, which is why the gap reached production.
- **`npm run style:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte.

`SECOND_ORDER_DIRECTIVE` in `app/services/verticals/383b99d1.js` is appended to the Devin prompt via `alertData.promptAppendix`, sending the session to the audit first, then to the spec and the build's missing coverage gate. Regression coverage for both paths lives in `tests/gap-style-affinity.test.js`.

### S&P Global feed-migration parity scenario

The S&P Global Market Intelligence vertical (`/spglobal`, slug `da6578ee`) plants **one field-mapping gap with two symptoms**, aimed at a data-platform audience mid-migration from legacy feed handlers onto a Databricks/Delta lakehouse. Wave 3 onboarded a `depositary_receipt` instrument class mapped to the `equity_adr` contract code, but that code was never given a contract:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `normalizeMigratedRow()` | Dereferences the missing contract's `priceScale` and throws | `TypeError` → Sentry → Slack → Devin session |
| `runParityCheck()` | Cannot normalize those rows, so it holds them out of the comparison population and divides matches by what is left | HTTP 200 reporting `parity_match_rate = 1.0`. Only `feed.parity_coverage` sits below 1.0 |

The silent half is the point: a migration that reports 100% parity on a population it silently narrowed is worse than one that reports a failure — the excluded class never lands in Delta.

**The defect originates in the pipeline, not the route.** `pipelines/spgi/feed-mapping-spec.json` is the source of truth for instrument-class mapping; `pipelines/spgi/build-feed-contract.js` materializes it into `app/services/verticals/features/da6578ee-feed-contract.json`, which the service loads at require time. A class declared in `instrumentClasses` with no entry under `contracts` builds clean — the build has no coverage gate, which is what lets the gap ship.

Three things are deliberately separate:

- **The defect is left in place** so Devin performs the fix live. To run the demo pre-fixed, add an `equity_adr` contract to the spec and run `npm run feed:build`. The service `require`s the built artifact, so **restart the server after a rebuild**.
- **`scripts/spgi-parity-audit.js` is the prevention control** (`npm run audit:spgi`) — it drives every instrument class the *service* can publish through the real parity harness and exits non-zero when a class is undeclared in the spec, mapped inconsistently between spec and service, absent from the contract, or contributing no compared rows. It is not wired into the build, which is why the gap reached production.
- **`npm run feed:check`** fails when the committed artifact does not match a fresh build of the spec, and `npm test` asserts the same thing byte-for-byte.

`PARITY_DIRECTIVE` in the service is appended to the Devin prompt via `alertData.promptAppendix`. It sends the session to the audit first, then to the spec, the build's missing coverage gate, and the harness's fail-open exclusion logic. Regression coverage for both paths lives in `tests/spgi-feed-parity.test.js`.

### GE Aerospace Customer Portal scenario (Flutter, external repo)

The GE Aerospace vertical (slug `5b992ae7`) has two surfaces. The marketing page at `/5b992ae7` keeps its Node-side technical-inquiry TypeError. The **customer portal** at `/5b992ae7/app` is a Flutter web build served statically from `app/public/verticals/5b992ae7-app/` (SPA fallback in `app/routes/verticals/5b992ae7.js`); the same codebase ships natively for Linux, Windows, macOS/iOS and Android from `Custom-Devin-Demos/ge-customer-portal`, and that repo — not this one — is where the defect lives and where Devin remediates.

The portal plants a routing/catalog mismatch: `SEGMENT_ROUTING` quotes `rise` for narrowbody operators but the engine catalog never registers it, so `buildEngineCoverage` null-asserts and every US/CA technical inquiry fails — on the hosted web build at `/5b992ae7/app` as well as natively, because the hosted artifact is built from the defective Flutter `main`. The Flutter client reports to Sentry as service `customer-5b992ae7-portal` (release `ge-customer-portal@<version>`) and, after rendering its error card, also `POST`s the failure to `/api/5b992ae7/portal/error`. That route (`reportPortalFailure` in the service) raises the Slack alert and Devin session directly under the portal identity — no Sentry webhook round-trip needed — carrying the client's `platform`, `operator`, `segment`, `screen` and `action` tags, and rejects bodies that do not carry `source: ge-customer-portal/<platform>` with `service: customer-5b992ae7-portal`. Because the Flutter client has no org/user picker, that path relies on `DEVIN_ORG_ID_5B992AE7` / `DEVIN_USER_ID_5B992AE7` being set alongside `DEVIN_SERVICE_KEY_5B992AE7` (`getCustomerConfig().devinOrgId`); without the org override the session call lands in the global `DEVIN_ORG_ID` org, which the per-customer key cannot access. `POST /api/5b992ae7/inquiry` recognises a `source: ge-customer-portal/<platform>` body as a registration-only call — it acknowledges the client-generated reference number instead of re-running the Node-side routing logic.

Two identities share the slug and must not claim each other's alerts: `CUSTOMER_ALERT_IDENTITY` in `app/routes/sentry-webhook.js` matches on the full service name (`customer-5b992ae7-inquiry` vs `customer-5b992ae7-portal`), not the `customer-<slug>-` prefix. Both the webhook entry and `/portal/error` append `PORTAL_REMEDIATION_DIRECTIVE` (exported from `app/services/verticals/5b992ae7.js`) to the Devin prompt: reproduce on web first, fix the catalog data (register CFM RISE, make coverage tolerant), re-verify on web, open a PR against `main` in the Flutter repo, stop for human approval, then spawn separate Linux/Windows/macOS child sessions that build the same fix commit natively, submit the same narrowbody inquiry and post recordings plus the verified SHA to the PR, and finally refresh the hosted web build here. Regression coverage lives in `tests/sentry-webhook.test.js` and `tests/5b992ae7-portal-error.test.js`.

To refresh the hosted web build: in the Flutter repo run `flutter build web --release --base-href /5b992ae7/app/`, copy `build/web/` into `app/public/verticals/5b992ae7-app/`, and delete the copied `canvaskit/` directory — the default build loads CanvasKit from Google's CDN, so the 37 MB local copy is dead weight in this repo.

### Citi consumer banking scenario (67f2a7ba, Flutter, external repo)

The Citi Mobile vertical (slug `67f2a7ba`, aliases `/citimobile`, `/citi-mobile`; unlisted on the hub) is separate from Citi Self Invest (`94f4c31f`, `/citi`), which keeps its Node-side suitability TypeError. `/67f2a7ba/app` serves a Flutter web build from `app/public/verticals/67f2a7ba-app/` (SPA fallback in `app/routes/verticals/67f2a7ba.js`). The same codebase — `Custom-Devin-Demos/citi-banking-demo-app` — renders as a Citi Online desktop site on wide web and as the Citi Mobile app on Android/iOS/narrow web, and that repo is where the defect lives and where Devin remediates.

The app plants a registry mismatch: the card product catalog knows the Citi Strata Elite card, but the payment-posting rules registry never registers it, so scheduling a payment on that card (the default selection) null-asserts and the Pay Card screen shows its error card. The client then `POST`s to `/api/67f2a7ba/mobile/error` with `source: citi-mobile/<screen>` and `service: customer-67f2a7ba-mobile`, plus `platform`, `screen`, `action`, `product`/`cardProduct` tags. `reportAppFailure` in `app/services/verticals/67f2a7ba.js` raises the Slack alert and Devin session directly (Sentry capture + `mobile_payment.failure` metric); successful payments register on `POST /api/67f2a7ba/payments` (`mobile_payment.success`, no alert).

Identity is dynamic: the Flutter client reads `devinEmail` / `devinUserId` / `devinOrgId` / `devinOrgName` that the hub stored in `localStorage` and forwards them on the report. The service passes them through untouched and never invents a fallback identity; `DEVIN_SERVICE_KEY_67F2A7BA` / `DEVIN_USER_ID_67F2A7BA` / `DEVIN_ORG_ID_67F2A7BA` only fill in when the client sent nothing. `CUSTOMER_ALERT_IDENTITY` in `app/routes/sentry-webhook.js` maps `customer-67f2a7ba-mobile` to `APP_REMEDIATION_DIRECTIVE`, which tells the session to reproduce on web, fix the registry (register the product, make consumers tolerate unknown codes, add a completeness test), verify the same fix commit on web, Android and iOS, and refresh the hosted build here. Regression coverage lives in `tests/67f2a7ba-mobile-error.test.js`.

Refresh the hosted build the same way as GE: `flutter build web --release --base-href /67f2a7ba/app/`, copy `build/web/` into `app/public/verticals/67f2a7ba-app/`, drop `canvaskit/`. Generated Flutter bundles under `app/public/verticals/*-app/` are excluded from `npm run lint`.

### Nordstrom shopping scenario (5b7227b4, Flutter, external repo)

The Nordstrom app vertical (slug `5b7227b4`, aliases `/nordstromapp`, `/nordstrom-app`; unlisted on the hub) is separate from the Nordstrom HTML vertical (`663500bd`, `/nordstrom`), which keeps its Node-side defect. `/5b7227b4/app` serves a Flutter web build from `app/public/verticals/5b7227b4-app/` (SPA fallback in `app/routes/verticals/5b7227b4.js`). The same codebase — `Custom-Devin-Demos/nordstrom-shopping-demo-app` — renders as the nordstrom.com desktop site on wide web and as the Nordstrom app on Android/iOS/narrow web, and that repo is where the defect lives and where Devin remediates.

The app plants a registry mismatch: the product catalog carries a `New Markdown` price status, but the Nordy Club earning-rules registry never registers it, so adding a New Markdown item to the bag null-asserts while pricing rewards and the product screen shows its error message plus the incident toast. The client then `POST`s to `/api/5b7227b4/mobile/error` with `source: nordstrom-shop/<platform>` and `service: customer-5b7227b4-mobile`, plus `platform`, `screen`, `action`, `product`, `priceStatus` tags. `reportAppFailure` in `app/services/verticals/5b7227b4.js` raises the Slack alert and Devin session directly (Sentry capture + `add_to_bag.failure` metric); successful adds sync on `POST /api/5b7227b4/bag` (`add_to_bag.success`, no alert).

Identity is dynamic, exactly as for Citi Mobile: the Flutter client forwards `devinEmail` / `devinUserId` / `devinOrgId` from the hub's `localStorage` (or the native sign-in email), the service passes them through untouched, resolves an email to a Nordstrom org member with `DEVIN_SERVICE_KEY_5B7227B4` when no user id was sent, and `DEVIN_USER_ID_5B7227B4` / `DEVIN_ORG_ID_5B7227B4` only fill in when the client sent nothing. `CUSTOMER_ALERT_IDENTITY` maps `customer-5b7227b4-mobile` to the Nordstrom `APP_REMEDIATION_DIRECTIVE` (fix the registry, tolerate unknown statuses, add a completeness test, verify one commit on web, Android and iOS, refresh the hosted build). Regression coverage lives in `tests/5b7227b4-mobile-error.test.js`.

Refresh the hosted build the same way as Citi: `flutter build web --release --base-href /5b7227b4/app/`, copy `build/web/` into `app/public/verticals/5b7227b4-app/`, drop `canvaskit/`.

### NVIDIA GeForce NOW scenario (315f52fe, native SwiftUI iOS, external repo)

The NVIDIA vertical (slug `315f52fe`, aliases `/nvidia`, `/geforce-now`, `/geforcenow`; unlisted on the hub) is a **native SwiftUI iOS app — iOS only, no web or Android build and no hosted web build**. `/315f52fe` serves a GeForce NOW-branded landing page (`app/public/verticals/315f52fe.html`) that explains how to clone, build and run the app on an iPhone simulator; the customer-facing app itself lives in `Custom-Devin-Demos/nvidia-geforce-now-demo-app`, and that repo is where the defect lives and where Devin remediates (`Core/` is a Foundation-only Swift package whose tests also run on Linux; `App/` is the SwiftUI target, generated with XcodeGen and verified with `scripts/verify-ios.sh` on macOS).

The app plants a registry mismatch: every membership tier is scheduled onto a cloud rig class (`RigCatalog.rigClass(for:)` — Free → `basic`, Performance → `rtx4080`, Ultimate → `rtx5080`) but the stream-profile registry (`StreamProfileRegistry.profiles`) only registers `basic` and `rtx4080`, so tapping **Play** as an Ultimate member throws `StreamProfileError.unregisteredRig(.rtx5080, device)` and the game screen shows the "couldn't start your session" card plus the incident banner. Performance members launch fine. The client then `POST`s to `/api/315f52fe/ios/error` with `source: geforce-now-ios/ios` and `service: customer-315f52fe-ios`, plus `platform`, `screen`, `action`, `game`, `tier`, `rigClass`, `device`, `osVersion`, `appVersion` and a bounded `launch` context. `reportAppFailure` in `app/services/verticals/315f52fe.js` raises the Slack alert and Devin session directly (Sentry capture + `play.launch.failure` metric) and the Sentry webhook skips the same event via `INSTANT_PATH_SLUGS` / the `alert_path: instant` tag.

Identity is pinned, not derived from the app: this demo was commissioned by Shawn, so `OWNER` in the service (`shawn@cognition.ai`, Slack `U08RSEMUV3L`, his Devin user id, the NVIDIA org id) is passed to `createSessionAndAlert` on every report — the card @-mentions him and the Devin session is created as him. The app still forwards `devinEmail` / `devinUserId` / `devinOrgId`, but the sign-in email is synthetic and only survives on the card as `extra.reporterEmail`; it never redirects ownership. `CUSTOMER_ALERT_IDENTITY` maps `customer-315f52fe-ios` to the NVIDIA `APP_REMEDIATION_DIRECTIVE` (register the missing rig profiles, make the lookup throw a typed error instead of crashing on a gap, add a tier × device completeness test, verify one commit on the iOS simulator, stop for human approval before merge). Regression coverage lives in `tests/315f52fe-ios-error.test.js`.

**One failure, one alert.** Every report that reaches `POST /api/315f52fe/ios/error` raises a Slack alert and a Devin session, so a reproduction run must not report. The directive tells the remediation session to reproduce with failure reporting off (`scripts/verify-ios.sh` in the app repo disables it by default; `GFN_DISABLE_FAILURE_REPORTS=1` in the app environment otherwise), and only the presenter's live run — `REPORT_FAILURES=1 scripts/verify-ios.sh`, or a plain Xcode launch — reports. A remediation session that reproduces with reporting on opens a second alert and a second session for the same defect, which then reproduces again: that loop is what this rule prevents.

### ComEd Report Outage scenario (d08b052d, Flutter, external repo)

The ComEd (Exelon) vertical (slug `d08b052d`, aliases `/comed`, `/comed-app`, `/exelon`; unlisted on the hub) is a Flutter customer-account app, not an HTML page. `/d08b052d/app` serves a Flutter web build from `app/public/verticals/d08b052d-app/` (SPA fallback in `app/routes/verticals/d08b052d.js`). The same codebase — `Custom-Devin-Demos/exelon-utility-demo-app` — renders as the comed.com My Account desktop site on wide web and as the ComEd mobile app on Android/iOS/narrow web, and that repo is where the defect lives and where Devin remediates.

The app plants a registry mismatch: the meter registry (`MeterType.all`) and the synthetic customer's Home premise carry a next-generation smart meter (`ami_gen2`), but the outage dispatch registry (`dispatchRules`, crew + ETR per meter type) never registers it, so Report Outage for that premise null-asserts while building the dispatch plan and the screen shows the "couldn't submit" card plus the incident toast. The Rental premise (`ami_smart`) reports fine. The client then `POST`s to `/api/d08b052d/mobile/error` with `source: comed-account/<platform>` and `service: customer-d08b052d-mobile`, plus `platform`, `screen`, `action`, `servicePoint`, `meterType`, `meterId`, `zip`, `outageType` tags. `reportAppFailure` in `app/services/verticals/d08b052d.js` raises the Slack alert and Devin session directly (Sentry capture + `report_outage.failure` metric); successful tickets sync on `POST /api/d08b052d/outages` (`report_outage.success`, no alert).

Identity is dynamic, exactly as for Citi and Nordstrom: the client forwards `devinEmail` / `devinUserId` / `devinOrgId` from the hub's `localStorage` (or the native sign-in email), the service resolves an email to an Exelon org member with `DEVIN_SERVICE_KEY_D08B052D` when no user id was sent, and `DEVIN_USER_ID_D08B052D` / `DEVIN_ORG_ID_D08B052D` only fill in when the client sent nothing. `CUSTOMER_ALERT_IDENTITY` maps `customer-d08b052d-mobile` to the ComEd `APP_REMEDIATION_DIRECTIVE` (register the meter type, tolerate unknown registry entries, add a `MeterType.all` completeness test, verify one commit on web, Android and iOS, refresh the hosted build). Regression coverage lives in `tests/d08b052d-mobile-error.test.js`.

Refresh the hosted build the same way: `flutter build web --release --base-href /d08b052d/app/`, copy `build/web/` into `app/public/verticals/d08b052d-app/`, drop `canvaskit/`.

### FPL My Account scenario (b425648c, Flutter, external repo)

The FPL vertical (slug `b425648c`, aliases `/fpl`, `/nextera`; unlisted on the hub) is Florida Power & Light — a NextEra Energy company — as its customers see it. `/b425648c` serves an fpl.com-styled landing page (`app/public/verticals/b425648c.html`) that links into `/b425648c/app`, a Flutter web build from `app/public/verticals/b425648c-app/` (SPA fallback and `/fpl-app` redirects in `app/routes/verticals/b425648c.js`). The same codebase — `Custom-Devin-Demos/fpl-my-account-demo-app` — renders as fpl.com My Account (Account Summary, Bill, Energy Manager, Power Outages) on wide web and as the FPL Mobile App (bottom tabs) on Android/iOS/narrow web, and that repo is where the defect lives and where Devin remediates.

The app plants a registry mismatch: both service points (Palm Beach Gardens `0123456780` and Jupiter `0123456798`) sit on `storm_secure_underground` circuits, but `restorationProfiles` in `lib/domain/circuits.dart` only registers overhead, underground and hardened-feeder profiles, so every Report an Outage submission null-asserts in `estimateRestoration` while estimating the restoration window. The form has no field validation, so submitting it as-is reproduces the failure. The outage screen shows the "We couldn't submit your outage report" card plus the incident toast, and the client `POST`s to `/api/b425648c/mobile/error` with `source: fpl-my-account/<platform>` and `service: customer-b425648c-mobile`, plus `platform`, `screen`, `action`, `accountNumber`, `premiseId`, `circuitType`, `problem` tags. `reportAppFailure` in `app/services/verticals/b425648c.js` raises the Slack alert and Devin session directly (Sentry capture + `outage_report.failure` metric); once the profile is registered, tickets sync on `POST /api/b425648c/outage/report` (`outage_report.success`, no alert).

Identity is dynamic, exactly as for Nordstrom: the Flutter client forwards `devinEmail` / `devinUserId` / `devinOrgId` from the hub's `localStorage` (or the native sign-in email), the service passes them through untouched, resolves an email to a NextEra org member with `DEVIN_SERVICE_KEY_B425648C` when no user id was sent, and `DEVIN_USER_ID_B425648C` / `DEVIN_ORG_ID_B425648C` only fill in when the client sent nothing. `CUSTOMER_ALERT_IDENTITY` maps `customer-b425648c-mobile` to the FPL `APP_REMEDIATION_DIRECTIVE` (register the missing profile, tolerate unknown circuits, add a completeness test, verify one commit on web, Android and iOS, refresh the hosted build). Regression coverage lives in `tests/b425648c-mobile-error.test.js`.

Refresh the hosted build the same way: `flutter build web --release --base-href /b425648c/app/`, copy `build/web/` into `app/public/verticals/b425648c-app/`, drop `canvaskit/`.

### BNY NEXEN collateral overview scenario (9bfabd45, Vite/React, external repo)

The BNY vertical (slug `9bfabd45`, aliases `/bny`, `/nexen`; unlisted on the hub) is NEXEN, BNY's institutional custody platform. There is no landing page: `/bny`, `/nexen` and `/9bfabd45` all redirect to `/9bfabd45/app`, a Vite/React build from `app/public/verticals/9bfabd45-app/` (SPA fallback in `app/routes/verticals/9bfabd45.js`). The app is `COG-GTM/bny` — a React frontend running on its baked-in mock client plus a Spring Boot mirror of the same domain that is never deployed — and that repo is where the defect lives and where Devin remediates.

The app plants an onboarding gap on its landing screen: `MERIDIAN CAPITAL PARTNERS` is listed in `clients` (and seeded in the Java mirror `backend/src/main/resources/data.sql`) but has no `collateralByClient` aggregate, so selecting it on **Collateral Overview** makes `summariseCollateral` in `frontend/src/domain/collateral.ts` dereference undefined and the dashboard fails to load. The other two clients render normally. The client `POST`s to `/api/9bfabd45/error` with `source: nexen-custody/web` and `service: customer-9bfabd45-web`, plus `platform`, `screen` (`collateral_overview`), `action` (`load_collateral_overview`) and `client_name` tags. `reportAppFailure` in `app/services/verticals/9bfabd45.js` raises the Slack alert and Devin session directly (Sentry capture + `collateral_overview.failure` metric).

The digital asset custody feature is deliberately *not* the incident: it is the feature Devin builds live during the demo (`COG-GTM/bny` PR #2).

Identity: the client may forward `devinEmail` / `devinUserId` / `devinOrgId`, and the service resolves an email to an org member with `DEVIN_SERVICE_KEY_9BFABD45` when no user id was sent; with nothing from the client it falls back to the demo owner (Hannah Huh, `U0B2YAUPSHL`), who is also the `slackMemberId` on every card. `CUSTOMER_ALERT_IDENTITY` maps `customer-9bfabd45-web` to the NEXEN `APP_REMEDIATION_DIRECTIVE` (seed the missing collateral aggregate in both mirrors, replace the undefined dereference with explicit handling, add frontend and backend completeness tests, refresh the hosted build). Regression coverage lives in `tests/9bfabd45-error.test.js`.

Refresh the hosted build: in `COG-GTM/bny/frontend`, `npx vite build --base=/9bfabd45/app/`, then copy `dist/` into `app/public/verticals/9bfabd45-app/`.

### Samsara Fleet mobile scenario (26a3d261, SwiftUI, external repo)

The Fleet vertical is the native SwiftUI Samsara Fleet replica in `COG-GTM/ios-demos` (`apps/26a3d261`, iOS + macOS, no hosted web build and no telemetry SDK). Its planted defect is silent — "Share live ETA" on asset 224221 computes an arrival equal to the fleet clock (0 min out) — so the app checks the invariant itself and, on failure, `POST`s bounded facts (`source: fleet-mobile/<ios|macos>`, `service: fleet-mobile`, asset, route, strict ISO-8601 departure/arrival, time zone, screen/action, optional `devinEmail`) to `/api/oncall/26a3d261/eta-failure`. `reportEtaFailure` in `app/services/oncall-verticals/fleet.js` owns everything the app must not carry: it allocates the `FLT-xxxxxx` Incident Ref, emits the `fleet_live_share.eta_failure` metric and a Sentry message tagged with the on-call route (so `isOncallSliceEvent` in the Sentry webhook never raises a second session), posts one alert card to `SLACK_ONCALL_ALERTS_CHANNEL_ID`, creates one Devin session on `platform: macos` (`DEVIN_ONCALL_FLEET_PLATFORM` to override) against `COG-GTM/ios-demos` with a fixed server-side prompt, and links the session in the alert thread. The route validates and normalises before the hourly trigger cap, rejects healthy ETAs (arrival after departure), and answers `202` with `reference` + `statusToken`; `GET /api/oncall/26a3d261/eta-failure/:reference` needs that token in the `X-Status-Token` header (never a query string) because the reference is printed on the alert card; the in-memory status map keeps at most 200 reports for six hours and evicts finished entries before unfinished ones. The `#oncall-alerts` Slack responder automation skips messages containing `fleet-mobile` so only the macOS session investigates. Regression coverage lives in `tests/oncall-fleet-eta-failure.test.js`.

### Partiful RSVP mobile scenario (205bc15f, SwiftUI, external repo)

The Partiful vertical is the native SwiftUI Partiful replica in `COG-GTM/ios-demos` (`apps/205bc15f`, iOS + macOS, no telemetry SDK), plus a browser replica of the same screens at `/partiful` (`/205bc15f`) for demoing without Xcode. Its planted defect is a blank page — an event whose host picked a text-only theme has no cover photo, so the RSVP page model cannot be built and the guest sees nothing (`pasta-night-mine`, `board-game-night`; photo events render normally). The app reports it itself, `POST`ing bounded facts (`source: partiful-rsvp/<ios|macos|web>`, `service: partiful-rsvp`, event id/title, host, theme, screen/action, `reason`, guest counts, invite link, optional `devinEmail`) to `/api/oncall/205bc15f/rsvp-page-failure`. `reportRsvpPageFailure` in `app/services/oncall-verticals/partiful.js` mirrors the Fleet slice: it allocates the `PTF-xxxxxx` Incident Ref, emits the `partiful_rsvp.page_failure` metric and a Sentry message tagged with the on-call route (so `isOncallSliceEvent` never raises a second session), posts one alert card to `SLACK_ONCALL_ALERTS_CHANNEL_ID`, creates one Devin session on `platform: macos` (`DEVIN_ONCALL_PARTIFUL_PLATFORM` to override) against `COG-GTM/ios-demos`, and links the session in the alert thread. `reason` must be a key of `REASONS` — the prompt never carries a client string the server cannot explain — and the invite link is only kept when it is an `https://partiful.com` URL. The route answers `202` with `reference` + `statusToken`; `GET /api/oncall/205bc15f/rsvp-page-failure/:reference` needs that token in the `X-Status-Token` header, and the app polls it to show "Devin is investigating" under the blank page. Like Fleet, the `#oncall-alerts` responder automation must skip messages containing `partiful-rsvp` so only the macOS session investigates. Regression coverage lives in `tests/oncall-partiful-rsvp-failure.test.js`. `app/public/verticals/205bc15f.html` is the browser replica: the same feed, RSVP page, and blank page rendered in a phone frame, carrying the same defect in `buildPage()` and reporting with `source: partiful-rsvp/web`, so a demo needs only the URL.

### Bank of America Zelle field-migration scenario (6f43e66c, /bofa-snow)

The Bank of America Zelle vertical (`/6f43e66c`, `/bofa-snow`) plants one field-migration gap with two consumers:

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `sendMoney()` | Reads the pre-FY26 `account.limitProfile` field and throws before a transfer completes | HTTP 500 `TypeError` → Sentry → Slack → Devin session |
| `requestMoney()` | Reads the pre-FY26 field and falls back to Standard, so Gold/Platinum requests are declined below their enrolled tier's cap | HTTP 422 with no Sentry/Devin alert; `zelle_request.declined` carries `profile:Standard` |

The defect is deliberately left in place so Devin performs the field-migration fix. The enrolled profile now lives at `account.limits.profile`, but both consumers still read the old location; only the send path crashes.

- **`scripts/6f43e66c-limits-audit.js` is the prevention control** (`npm run audit:zelle`) — it probes both real service paths for every funding account and exits non-zero for unresolved or downgraded profiles. It is not wired into CI, which is why this shipped.
- `REMEDIATION_DIRECTIVE` fans out to three child sessions: code blast radius, ServiceNow incident blast radius, and prevention/audit wiring. The customer is configured for the ServiceNow incident path via `itsm: 'servicenow'`.

### Aravia Patient Access field-migration scenario (fcf0f903, /patient-access)

The Aravia Therapeutics Patient Access vertical (`/fcf0f903`, `/patient-access`) is a customer-neutral life-sciences skin — a fictional specialty-pharma brand, no real company assets — that mirrors the Zelle shape: one field-migration gap with two consumers, in the domain of copay-assistance enrollment for a specialty therapy.

| Consumer | Behavior | Signal |
|----------|----------|--------|
| `submitEnrollment()` | Reads the pre-FY26 `patient.coverageTier` field, resolves no benefit and throws while dereferencing it (`assertAssistanceCoverage`) | HTTP 500 `TypeError` → Sentry → Slack → Devin session → ServiceNow |
| `estimateCopay()` | Reads the pre-FY26 field and falls back to `commercial-standard`, so Specialty Commercial ($10) and Foundation Assistance ($0) patients are quoted the $150 Standard copay and told they are not assistance-eligible | HTTP 200 with no Sentry/Devin alert; `copay_estimate.quoted` carries `tier:Standard` on patients whose verified tier is not Standard |

The silent half is the point: the crash is what pages you; the quiet quote is what harms patients. The defect is deliberately left in place so Devin performs the field-migration fix live. The FY26 benefits refresh moved the verified tier to `patient.coverage.tier` in `app/services/verticals/fcf0f903-patients.js`, but both consumers in `app/services/verticals/fcf0f903.js` still read the old location; only the enrollment path crashes. To run the demo pre-fixed, point both resolvers at `patient.coverage.tier` (ideally through one shared resolver that throws when a tier cannot be resolved).

- **`scripts/fcf0f903-copay-audit.js` is the prevention control** (`npm run audit:copay`) — it resolves the benefit for every patient record through both real service paths and exits non-zero for unresolved or silently downgraded tiers. It is not wired into `npm test`/CI, which is why this shipped; wiring it in is the demo's prevention workstream.
- `REMEDIATION_DIRECTIVE` fans out to three child sessions: code blast radius (incl. the silent estimate consumer), ServiceNow incident blast radius in assignment group "Patient Access Platform Engineering", and prevention/audit wiring. The customer is configured for the ServiceNow incident path via `itsm: 'servicenow'` in `config/customers/fcf0f903.js`.
- Regression coverage for both paths lives in `tests/fcf0f903-enrollment.test.js` and `tests/fcf0f903-copay-estimate.test.js`; the estimate tests pin the current Standard fallback and must be updated when the defect is fixed.

### Incident Lab (evolving-incident demo)

The Incident Lab (`/oncall/incident-lab`, unlisted) runs a long-form incident where the data develops over time and Devin investigates an external subject repo (the n8n fork at `ananthv26-cog-demo-repos/n8n`) rather than this app. Scenarios are JSON documents in `config/incident-lab/`; the run engine is `app/services/incident-lab/engine.js` with three sinks:

- **Warehouse seed** (`app/services/incident-lab/supabase-seed.js`) — on arm, replays the scenario's `warehouse.seedFile` from `scripts/incident-lab/` against `INCIDENT_LAB_WAREHOUSE_URL` (falling back to `SUPABASE_WAREHOUSE_URL`). The seeds are idempotent and carry timestamps relative to the arm, so the warehouse rows an investigator is pointed at always line up with the run's backdated telemetry. Seeding never blocks a run — a missing URL or an unreachable warehouse is reported on the run log and the run arms anyway. From an IPv4-only host, point `INCIDENT_LAB_WAREHOUSE_URL` at Supabase's session pooler; the direct `db.<ref>.supabase.co` host is IPv6-only.
- **Datadog emitter** (`app/services/incident-lab/datadog-emitter.js`) — emits real metrics (`<prefix>.*` under `service:<scenario.service>`) and logs to Datadog: messy baseline noise while armed, prelude precursor bursts, outage phases with backfilled history at declaration, and recovery on the manual `mitigated` phase. Declares/resolves the incident through the Datadog Incidents API with the scenario's severity.
- **Slack persona layer** (`app/services/incident-lab/personas.js`) — waits for the channel that Datadog's Slack integration creates (`incident-<publicId>-` marker), joins it, and posts the scripted persona timeline (`chat:write.customize`), including scripted @Devin asks. With `FIREWORKS_API_KEY` (preferred) or `OPENAI_API_KEY` set, a small-LLM responder answers investigator messages in character, restricted to facts unlocked at the current timeline position (never the planted root cause), and a director decides the fate of each scripted beat just before it posts — `post`, `skip` (the investigator already covered it), `hold` (they are mid-task), or `advance` (they are ahead, so pull the rest of the timeline forward). The director fails open to `post`, never skips a beat carrying a phase action, and can be disabled per scenario with `llm.director: false`. Because a spoiler posted early cannot be retracted, the authored timeline keeps the beats that give away the mechanism or the culprit late and lets `advance` pull them forward, and the beat carrying the phase action may be held far longer (20 min) than an ordinary beat (4 min). Beats that fall behind a hold drain with a 20–45s gap rather than all at once. The same LLM also watches for the investigator asking for one of the scenario's authored `mitigations.options`: the named responder acknowledges it, the phase that option carries (if any) activates two minutes later, and a responder then reports what the telemetry actually did. Matching is restricted to that authored list, each option fires once, an option with no phase changes nothing, and the scripted beat carrying the same action stays as the deadline. Knowledge entries may unlock on a `phase` as well as on the script clock, so a mitigation pulled forward brings its own recovery facts and nothing else's. Personas post under illustrated avatars served from this app (`app/public/incident-lab/avatars/`, referenced by a persona's `avatar` path and resolved against `ONCALL_DEMO_BASE_URL`/`DOMAIN_NAME`) so the channel reads like real people rather than emoji-headed bots; a persona with no `avatar` falls back to its `icon` emoji.

The engine never creates Slack channels — the flow is: declare via Datadog Incidents API → Datadog Slack integration creates the channel → the incident responder auto-joins on the channel prefix → personas and telemetry evolve in that channel. Control endpoints (`/api/incident-lab/run|arm|declare|phase|stop`) require `INCIDENT_LAB_TOKEN` via the `X-Lab-Token` header; status is public.

The control page drives `run`, which arms and schedules the declaration for the scenario's `leadInMs` (default 3 min) — long enough for baseline telemetry and the prelude burst to exist before the incident points an investigator at them, and the only pacing a presenter has to think about. The declaration is scheduled server-side and survives a restart (`resume` reschedules it, late rather than never); `stop` inside the lead-in cancels it. `arm` and `declare` remain separate endpoints for scripted rehearsals. Tests: `tests/incident-lab-*.test.js`.

## Repository Structure

```
├── app/
│   ├── server.js                  # Express app entry point (mounts all vertical routes)
│   ├── incidentModes.js           # Scenario state management (healthy, checkout-regression, etc.)
│   ├── public/
│   │   ├── hub.html               # Landing page with cards for the 9 listed verticals (payer is unlisted)
│   │   ├── index.html             # Retail eCommerce storefront UI
│   │   ├── oncall-report.html     # Shared customer-skinned support portal
│   │   ├── oncall-incident.html   # Shared customer-skinned SEV-1 incident console
│   │   └── verticals/
│   │       ├── banking.html       # Apex Bank — Online Banking
│   │       ├── financial-services.html  # Meridian Capital — Trading Platform
│   │       ├── insurance.html     # Shield Insurance — Claims Portal
│   │       ├── cpg.html           # Harvest Goods — Distributor Orders
│   │       ├── hightech.html      # NovaSoft — SaaS License Management
│   │       ├── industrials.html   # Titan Mfg — Equipment Maintenance
│   │       ├── industrials-quote.html # Titan Mfg — Instant Quote
│   │       ├── 08d969be.html       # Native industrials customer skin
│   │       ├── voice.html         # EchoScribe — Dictation Console (on-call only)
│   │       ├── 2acc11fd.html       # Native voice customer skin
│   │       ├── healthcare.html    # CarePoint — Patient Portal
│   │       ├── telco.html         # WaveConnect — Telecom Self-Service
│   │       └── payer.html         # Payer — Member ID card + pharmacy counter
│   ├── routes/
│   │   ├── storefront.js          # Retail: product catalog + checkout
│   │   ├── verticals/
│   │   │   ├── index.js           # Discovers + mounts every vertical route file and page (no hand edits)
│   │   │   ├── banking.js         # Banking: accounts + transfer
│   │   │   ├── financial-services.js  # Financial Services: portfolio + trade
│   │   │   ├── insurance.js       # Insurance: policies + claims
│   │   │   ├── cpg.js             # CPG: catalog + bulk orders
│   │   │   ├── hightech.js        # High Tech: subscriptions + license provisioning
│   │   │   ├── industrials.js     # Industrials: equipment + work orders
│   │   │   ├── healthcare.js      # Healthcare: providers + appointments
│   │   │   ├── telco.js           # Telco: plans + upgrades
│   │   │   └── payer.js           # Payer: ID cards + pharmacy claims
│   │   ├── oncall.js              # On-Call demo pages, alert/bug triggers, skinned routes
│   │   ├── oncall-verticals.js    # On-call vertical slice endpoints (/api/oncall/<vertical>/...)
│   │   ├── internal-jobs.js       # Slow-query patrol jobs (container-network-only; nginx returns 404)
│   │   ├── checkout.js            # Legacy checkout endpoint
│   │   ├── sentry-webhook.js      # Receives Sentry alert webhooks, triggers Devin via Slack
│   │   ├── webhook.js             # GitHub webhook handler
│   │   ├── health.js              # Health check endpoint
│   │   ├── login.js               # Auth endpoint
│   │   ├── search.js              # Product search
│   │   ├── orders.js              # Order lookup
│   │   └── admin.js               # Scenario management (GET/POST /admin/scenario)
│   ├── services/
│   │   ├── devin-session.js       # Builds investigation prompt, posts Slack alert, triggers Devin
│   │   ├── slack.js               # Slack API helpers (post messages, thread replies, delete messages)
│   │   ├── verticals/
│   │   │   ├── banking.js         # Banking business logic
│   │   │   ├── financial-services.js  # Trading business logic
│   │   │   ├── insurance.js       # Claims business logic
│   │   │   ├── cpg.js             # CPG order business logic
│   │   │   ├── hightech.js        # License provisioning business logic
│   │   │   ├── industrials.js     # Maintenance work order business logic
│   │   │   ├── healthcare.js      # Appointment scheduling business logic
│   │   │   ├── telco.js           # Plan upgrade business logic
│   │   │   ├── payer.js           # Pharmacy claim adjudication business logic
│   │   │   └── features/
│   │   │       └── eaa595e1-offer-affinity.json  # Built Kroger feature view (generated — do not hand-edit)
│   │   ├── oncall.js              # On-Call alert/bug-report cards, scenarios, incident state
│   │   ├── oncall-verticals/      # Copied vertical services for the on-call slice
│   │   │   ├── banking.js         # On-call banking business logic
│   │   │   ├── telco.js           # On-call telco business logic
│   │   │   ├── hightech.js        # On-call license provisioning business logic
│   │   │   ├── insurance.js        # On-call claims business logic
│   │   │   ├── industrials.js      # On-call instant quote business logic
│   │   │   ├── industrials-edge.js # On-call mTLS edge gateway, rotation, and certificate material
│   │   │   └── voice.js           # On-call dictation transcript business logic
│   │   ├── checkout.js            # Checkout business logic (includes scenario-based bugs)
│   │   ├── github-webhook.js      # GitHub webhook processing
│   │   ├── auth.js                # Auth service
│   │   ├── orders.js              # Order service
│   │   └── search.js              # Search service
│   └── telemetry/
│       ├── datadog.js             # Datadog APM + custom metrics init
│       ├── sentry.js              # Sentry SDK init
│       └── logger.js              # Winston structured JSON logger
├── loadgen/
│   └── worker.js                  # Synthetic traffic generator (search, login, orders — NOT checkout)
├── scripts/
│   ├── setup-datadog-dashboard.js # Creates Datadog dashboard via API
│   ├── setup-sentry-alerts.js     # Creates Sentry alert rules via API
│   ├── patrol-digest.js           # Formats validated Slow Query Patrol Slack digests
│   ├── patrol-before-after.js     # Compares pre-fix and fixed patrol job responses
│   ├── trigger.js                 # Manually trigger error scenarios
│   ├── warmup.js                  # Pre-warm the app
│   ├── welcome-season-sweep.js    # Validates Jan-1 plan card configs before cards mail (exits 1 on defect)
│   ├── kroger-personalization-audit.js  # Scores every membership tier through the ranker (exits 1 on an unencoded segment)
│   ├── spgi-parity-audit.js       # Drives every instrument class through the parity harness (exits 1 on an uncovered class)
│   ├── reset.js                   # Reset scenario to healthy
│   └── cleanup.js                 # Clean up resources
├── pipelines/
│   ├── kroger/
│   │   ├── offer-affinity-spec.json     # Source of truth for Kroger segment encoding
│   │   └── build-offer-features.js      # Materializes the spec into the served feature view
│   └── spgi/
│       ├── feed-mapping-spec.json       # Source of truth for SPGI instrument-class field mapping
│       └── build-feed-contract.js       # Materializes the spec into the served feed contract
├── config/
│   └── scenarios.json             # Scenario definitions
├── tests/
│   ├── ...                         # Vertical, pipeline, and integration test suites
│   ├── internal-jobs.test.js      # Slow-query patrol telemetry and ranking tests
├── docs/
│   ├── ...                         # Demo runbooks and scenario documentation
│   ├── patrol-evidence-chart.template.html # Shared evidence chart template for the daily patrol
│   └── slow-query-patrol-backlog.md # Slow-query patrol jobs, cadence, and telemetry contract
├── prompts/
├── docker-compose.yml             # 3 services: checkout-api, loadgen, datadog-agent
├── Dockerfile                     # checkout-api container
├── Dockerfile.loadgen             # loadgen container
├── eslint.config.mjs              # ESLint flat config
├── REVIEW.md                      # Instructions for automated code review (Devin Review)
└── .env.example                   # Template for environment variables
```

The daily patrol renders its evidence chart from `docs/patrol-evidence-chart.template.html` by copying it to `/tmp`, replacing the `MEASURED DATA` block with the run's Datadog numbers, and screenshotting it. The template is committed so every run's chart looks the same; the copy and screenshot are never committed. Datadog graph embeds are deliberately not used because the log-based metric only aggregates logs ingested after it was created.

## Tech Stack

- **Runtime:** Node.js 18+ (CommonJS — `require`/`module.exports`)
- **Framework:** Express 5.x
- **Error Tracking:** Sentry (`@sentry/node`)
- **APM/Metrics/Logs:** Datadog (`dd-trace`, `hot-shots` for StatsD)
- **Logging:** Winston (structured JSON)
- **HTTP Client:** Axios
- **Linting:** ESLint 10 (flat config)
- **Containerization:** Docker + Docker Compose

## How to Run Locally

```bash
# Install dependencies
npm install

# Start the app (no Docker, no Datadog agent)
npm start

# The app runs on http://localhost:3000
```

Open `http://localhost:3000` in a browser to see the hub landing page. It lists 9 of the 10 verticals — the payer demo is deliberately absent from `VERTICALS` and reached at `/welcome-season` — and clicking any card opens that demo.

### With Docker (full stack)

```bash
cp .env.example .env
# Fill in SENTRY_DSN, DD_API_KEY, DD_SITE at minimum
docker compose up --build -d
```

This starts 3 services:
- `checkout-api` — Express app on port 3000
- `loadgen` — Synthetic traffic generator (search/login/orders only, no checkout)
- `datadog-agent` — APM traces, metrics, log collection

## How to Lint

```bash
npm run lint
```

This runs ESLint across `app/`, `loadgen/`, `scripts/`, and `pipelines/`. Always run this before committing.

## Alert Pipeline Architecture

```
Vertical Error (any of 10 verticals)
    ├──▶ Sentry (captureException)
    │       └──▶ Sentry Alert Rule fires
    │               └──▶ Webhook to POST /webhooks/sentry
    │                       └──▶ createSessionAndAlert() [fallback path]
    │
    └──▶ createSessionAndAlert() [instant path, non-blocking]
            ├──▶ postBugReportToTriage() — mirrors the bug report to
            │       #automated-devin-triage (report-only, NO Devin session)
            ├──▶ postAlertToSlack() — bot token posts rich alert card
            └──▶ DEVIN_TRIGGER_MODE decides next step:
                    ├── "slack" (default): postDevinReply() — user token @Devin mention
                    │       └──▶ Native Devin Slack integration picks up @mention
                    └── "api": createDevinSession() — POST /v1/sessions
                            └──▶ postDevinSessionLink() — "View in Devin" button in thread
```

**Two error-detection paths exist:**
1. **Instant (all verticals):** Each vertical's route/service calls `createSessionAndAlert()` directly in the catch block (non-blocking, fire-and-forget). This triggers within seconds.
2. **Fallback (Sentry webhook):** `app/routes/sentry-webhook.js` receives the Sentry alert webhook and calls the same `createSessionAndAlert()`. This is slower (depends on Sentry alert rule evaluation).

Both paths call the same `createSessionAndAlert()` function. There is no deduplication — every call creates a new Devin session. Verticals may tag their Sentry events `alert_path: instant` to have the webhook fallback skip them (Rippling does).

**Two Devin trigger modes exist** (set via `DEVIN_TRIGGER_MODE` env var or per-customer config):
1. **`slack` (default):** Uses `SLACK_USER_TOKEN` to post `@Devin` in the alert thread. The native Devin Slack integration picks up the mention and starts a session. Requires Devin to be installed in the Slack workspace.
2. **`api`:** Calls `POST https://api.devin.ai/v1/sessions` directly via `DEVIN_API_KEY`. Posts a "View in Devin" button in the Slack thread. No user token or Devin Slack app needed — ideal for customer-specific demos running against a different Devin org.

**Per-customer configuration** (see `config/customers.js` and `config/customers/<slug>.js`):
Multiple customers can run simultaneously in a single deployment, each with their own Devin org/API key. Verticals pass `customer: '<slug>'` in their `alertData` to route to the correct config. Customer-specific env vars use a `_<SLUG>` suffix (e.g. `DEVIN_API_KEY_WAYFAIR`). See [Adding a new customer demo](#adding-a-new-customer-demo) below.

## Key Services

### `app/services/devin-session.js`
- `buildPrompt(alertData)` — Builds a rich Markdown investigation prompt with error details, occurrence info, tags, investigation steps, and context links.
- `createSessionAndAlert(alertData)` — Orchestrates the full alert flow: resolve per-customer config → post Slack alert → trigger Devin (via Slack @mention or API).

### `config/customers.js`
- `getCustomerConfig(customerSlug)` — Resolves Devin trigger config for a customer. Returns `{ triggerMode, apiKey, playbookId, slackUserId, targetRepo }`. Falls back to global env vars for the default customer.
- `CUSTOMERS` — Registry of customer slugs and their config overrides. `default` is inline; every other entry is loaded from `config/customers/<slug>.js` at require time, so a new customer adds one file and never edits a shared one.
- `listAliases()` — `{ alias: slug }` for every `aliases: [...]` declared in a customer file (friendly URLs such as `/publix` → `4c351052.html`). Duplicate aliases throw at boot.

### `app/routes/verticals/index.js` (filesystem discovery)
Nothing is registered by hand. At require time the router:
1. mounts every `app/routes/verticals/<id>.js` (sorted; each must export an express Router);
2. serves every alias from `listAliases()` (an alias must target an existing page);
3. serves every `app/public/verticals/<id>.html` at `/<id>` (route modules and aliases come first, so a module may own its own `/<id>` and an alias always beats a page of the same name).

Registry problems never crash boot: a module that fails to load or an alias with a missing target is logged (`logger.error`) and skipped, and a page that shadows an alias logs a warning. This matters because the EC2 tree can hold stale vertical files that neither repo has any more (deploys historically never deleted). The committed tree must still be clean — `tests/verticals-registry.test.js` fails on a skipped module, a page that does not serve 200, an alias with a missing target or one that shadows a page, or a service that passes a `customer` slug with no config file; `tests/verticals-stale-files.test.js` covers the tolerant-boot behavior against a scratch tree.

Only the hub's `VERTICALS` array stays hand-written: it is the allow-list of what the landing page shows. Customer demos are deliberately absent from it (direct URL only).

### `app/services/devin-api.js`
- `createDevinSession(prompt, options)` — Creates a Devin session via `POST /v1/sessions`. Accepts per-customer `apiKey` and `playbookId` via `options`. Returns `{ sessionId, url }`.

### `app/services/slack.js`
- `postAlertToSlack(alertData)` — Posts the rich Block Kit alert message using `SLACK_BOT_TOKEN`. Returns thread timestamp.
- `postBugReportToTriage(alertData)` — Mirrors the same bug report card to the triage channel (`SLACK_TRIAGE_CHANNEL_ID`, default `#automated-devin-triage`). Report-only: it omits the "Devin AI (auto-investigating)" line and never triggers a Devin session or thread follow-ups. Fire-and-forget; failures (e.g. bot not in channel) are logged and never affect the primary flow.
- `postDevinReply(threadTs, prompt, options)` — (slack mode) Replies in the alert thread using `SLACK_USER_TOKEN` with `@Devin + prompt`. Accepts per-customer `slackUserId` via `options`. Auto-deletes the reply after 5 seconds.
- `postDevinSessionLink(threadTs, sessionUrl)` — (api mode) Posts a "View in Devin" button in the alert thread using `SLACK_BOT_TOKEN`.
- `postMessage()`, `postThreadReply()`, `deleteMessage()` — Low-level Slack API helpers.
- `findChannelByNameFragment(token, fragment)`, `joinChannel(token, channelId)`, `postPersonaMessage(token, channel, text, username, icon)` (the icon is an emoji shortcode or an image URL, sent as `icon_url`), `inviteToChannel(token, channelId, userIds)` — SEV-1 persona chatter helpers. The chatter requires the bot to have the `channels:read`, `channels:join`, and `chat:write.customize` scopes; without `channels:join` the chatter logs a warning and skips seeding (the incident flow is unaffected). Inviting the participants (the triggering user resolved via `users.lookupByEmail`, and Devin via `DEVIN_SLACK_USER_ID`) additionally needs `users:read.email` and `channels:write.invites`; without them the invite logs a warning and is skipped.

### `app/incidentModes.js`
- Manages the current scenario state. Valid scenarios: `healthy`, `slow-db`, `checkout-regression`, `dependency-timeout`.
- The storefront checkout does NOT use scenario modes — it always fails regardless of the current scenario.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SENTRY_DSN` | Sentry project DSN | Yes |
| `DD_API_KEY` | Datadog API key | Yes (for Docker) |
| `DD_SITE` | Datadog site (e.g. `us5.datadoghq.com`) | Yes (for Docker) |
| `DD_INCIDENT_APP_KEY` | Datadog application key for Incident Management (SEV-1 declare/resolve). Owner needs an Incident Management seat. Falls back to `DD_APPLICATION_KEY` | For SEV-1 incidents |
| `ONCALL_SEV1_WINDOW_MS` | SEV-1 degradation window in ms (default 30 min) | No |
| `ONCALL_SEV1_AUTO_RESOLVE` | Set to `false` to leave the Datadog incident open when the window ends — synthetic probe traffic still stops, but responders resolve the incident themselves and Slack auto-archives the channel on its own schedule (default `true`) | No |
| `ONCALL_SEV1_PROBE_INTERVAL_MS` | Base delay between synthetic probe requests against the affected endpoint while a SEV-1 is open, measured from when the previous request completes. The effective delay is this base multiplied per evidence phase (6x/3x/1.5x/1x across the window), so at the default 10s base and 30-min window probes run every ~60s early on and every ~10s in the final phase | No |
| `ONCALL_SEV1_PROBE_MAX` | Max concurrent SEV-1 probe loops (default 25) | No |
| `ONCALL_CONFIG_OVERRIDE_TTL_MS` | Lifetime of a per-run config override (`POST /api/oncall/config`; the shipped baseline comes from `SCREENING_WINDOW_DAYS`/`SCREENING_CONCURRENCY`) when its run has no live incident window to inherit (default 45 min) | No |
| `ONCALL_CONFIG_OVERRIDE_MAX` | Cap on concurrently registered per-run config overrides; at capacity the oldest override without a live incident is evicted first (default 50) | No |
| `SCREENING_WINDOW_DAYS` | Compliance-screening lookback window for the on-call banking transfer path (default 90) | No |
| `SCREENING_CONCURRENCY` | Parallel screening-partner calls per batch on the on-call banking transfer path (default 1; the screening partner's per-client ceiling is 32 since VendorOps VO-8821 closed) | No |
| `ONCALL_REPO_URL` | Repo URL embedded in on-call Slack cards for responders to investigate (defaults to this repo) | No |
| `ONCALL_DEMO_BASE_URL` | Base URL for branded demo-page links in skinned on-call alerts (defaults to `https://$DOMAIN_NAME`, then devindemos.com) | No |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-`) for posting alerts | For alerts |
| `SLACK_USER_TOKEN` | Slack user OAuth token (`xoxp-`) for triggering Devin | For slack mode |
| `SLACK_CHANNEL_ID` | Slack channel ID for alert messages | For alerts |
| `DEMO_ONCALL_SLACK_MEMBER_ID` | Slack member ID @-mentioned as *On-Call* on customer-vertical alert cards whose vertical names no owner and whose run supplied no hub email. Unset, the field reads `_Unassigned_` and nobody is mentioned. Must be a real member; a made-up name is never rendered | No |
| `SLACK_TRIAGE_CHANNEL_ID` | Channel ID for the report-only bug-report mirror (default `#automated-devin-triage`). Never triggers a Devin session. Bot must be invited to the channel | No |
| `SLACK_TRIAGE_BOT_TOKEN` | Bot token for the triage mirror post (defaults to `SLACK_BOT_TOKEN`) | No |
| `SLACK_ONCALL_ALERTS_CHANNEL_ID` | Channel ID for on-call (`/oncall`) alert + incident posts | For on-call alerts |
| `SLACK_ONCALL_BUGS_CHANNEL_ID` | Channel ID for on-call bug-report posts | For on-call bug reports |
| `SLACK_ONCALL_ALERTS_CHANNEL_NAME` | Display label the on-call page ribbon shows after an alert posts ("Alert posted to …"). Label only — routing is decided by `SLACK_ONCALL_ALERTS_CHANNEL_ID` (default `#oncall-alerts`) | No |
| `SLACK_ONCALL_BUGS_CHANNEL_NAME` | Display label the on-call ribbon shows after a bug report posts. Label only — routing is decided by `SLACK_ONCALL_BUGS_CHANNEL_ID` (default `#oncall-bugs`) | No |
| `SLACK_ONCALL_BOT_TOKEN` | Bot token for on-call posts (defaults to `SLACK_BOT_TOKEN`) | No |
| `DEVIN_TRIGGER_MODE` | `slack` (default) or `api` — how Devin is triggered | No |
| `DEVIN_API_KEY` | Devin API key | For api mode |
| `DEVIN_SLACK_USER_ID` | Devin app's Slack user ID | For slack mode |
| `DEVIN_PLAYBOOK_ID` | Devin playbook ID for API sessions | No |
| `SONAR_TARGET_REPO` | Target repo for SonarCloud PR (default: `COG-GTM/etl-pipeline-demo`) | No |
| `DEVIN_API_KEY_<SLUG>` | Per-customer Devin API key (e.g. `DEVIN_API_KEY_A6B38C63`) | Per-customer |
| `DEVIN_PLAYBOOK_ID_<SLUG>` | Per-customer playbook ID | No |
| `SONAR_TARGET_REPO_<SLUG>` | Per-customer SonarCloud target repo | No |
| `DOMAIN_NAME` | Domain for Nginx reverse proxy + SSL (e.g. `devindemos.com`) | For SSL |
| `CERT_EMAIL` | Email for Let's Encrypt certificate notifications | For SSL |
| `APP_VERSION` | App version for telemetry | No (default: `1.0.0`) |
| `SENTRY_RELEASE` | Sentry release tag | No (default: `acme-checkout@1.0.0`) |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction of requests traced for performance/spans (1.0=100%, 0=off). Primary lever to control Sentry span volume; does not affect errors or the Slack/Devin alert pipeline | No (default: `0.1`) |
| `SENTRY_PROFILES_SAMPLE_RATE` | Fraction of traced transactions profiled (cannot exceed trace rate) | No (default: `0.1`) |
| `SENTRY_DROPPED_SPAN_OPS` | Comma-separated `span.op` values dropped via Sentry's `ignoreSpans` option (noisy Express router/middleware child spans). Keeps root transactions + db/http spans; does not affect errors or the Slack/Devin pipeline | No (default: `router.express,middleware.express`) |
| `SENTRY_ORG_SLUG` | Sentry organization slug (for issue URLs) | No |
| `SENTRY_PROJECT_ID` | Sentry project ID (for issue URLs) | No |
| `SENTRY_CLIENT_SECRET` | Sentry webhook client secret (HMAC signature verification) | Recommended |
| `DD_DASHBOARD_URL` | Datadog dashboard URL | No |
| `DD_ENV` | Datadog environment tag | No (default: `prod`) |
| `SESSION_SECRET` | Shared secret for session-creating endpoints (`x-session-secret` header) | Recommended |
| `PORT` | Server port | No (default: `3000`) |
| `INTERNAL_JOB_RATE_WINDOW_MS` | Sliding-window duration for internal job requests | No (default: `60000`) |
| `INTERNAL_JOB_PER_IP_RATE_LIMIT` | Accepted internal job requests per IP per window | No (default: `4`) |
| `INTERNAL_JOB_PROCESS_RATE_LIMIT` | Accepted internal job requests process-wide per window | No (default: `6`) |
| `LOADGEN_INTERVAL_MS` | Interval between synthetic traffic cycles (higher = less traffic = fewer spans) | No (default: `120000`) |

## Deployment

The app is deployed on an EC2 instance via Docker Compose with Nginx reverse proxy and SSL. The application code lives directly in `/home/ubuntu/` on the EC2 host (not in a subdirectory).

### Architecture

```
Internet → DNS (A record) → EC2 Public IP
                              │
                        ┌─────┴─────┐
                        │   nginx   │  :80 (→ HTTPS redirect)
                        │           │  :443 (SSL termination)
                        └─────┬─────┘
                              │ proxy_pass
                        ┌─────┴──────────┐
                        │  checkout-api  │  :3000 (internal only)
                        └────────────────┘
                        ┌────────────────┐
                        │   certbot      │  (auto-renews certs every 12h)
                        └────────────────┘
```

5 containers: `nginx` (reverse proxy + SSL), `checkout-api` (Express app), `certbot` (certificate renewal), `loadgen` (traffic generator), `datadog-agent` (telemetry).

### Domain & SSL Setup (one-time)

1. **Register a domain** (or use a subdomain of an existing domain)
2. **Create a DNS A record** pointing the domain to the EC2 public IP
3. **Open ports 80 and 443** in the EC2 security group (port 3000 can be closed)
4. **Set env vars** in `/home/ubuntu/.env` on EC2:
   ```bash
   DOMAIN_NAME=devindemos.com
   CERT_EMAIL=your-email@example.com
   ```
5. **Run the SSL init script** (once, on the EC2 host):
   ```bash
   cd /home/ubuntu && bash scripts/init-ssl.sh
   ```
   This starts nginx in HTTP-only mode, obtains a Let's Encrypt certificate via certbot, then restarts the full stack with SSL enabled.
6. **Update Sentry webhook URL** to `https://devindemos.com/webhooks/sentry`

After the initial setup, certificate renewal is fully automatic (certbot checks every 12 hours, nginx reloads every 6 hours).

### EC2 Redeploy Steps

Deployments are automated: the `Deploy to EC2` workflow (`.github/workflows/deploy.yml`) runs on every push to `main` in **both** source repos (COG-GTM and Custom-Devin-Demos), uploads the tree to `/home/ubuntu/incoming/<sha>` and hands it to `scripts/deploy-ec2.sh` on the host. Never `tar xzf` over `/home/ubuntu` by hand — that is how stale files and unregistered verticals used to pile up. For a manual redeploy use the same script:

```bash
tar czf /tmp/release.tar.gz --exclude=node_modules --exclude=.git --exclude=.env --exclude=certbot -C . .
scp /tmp/release.tar.gz ubuntu@<EC2_IP>:/home/ubuntu/release-manual.tar.gz
ssh ubuntu@<EC2_IP> bash -s <<'EOF'
set -euo pipefail
S=/home/ubuntu/incoming/manual; rm -rf "$S"; mkdir -p "$S"
tar xzf /home/ubuntu/release-manual.tar.gz -C "$S"; rm -f /home/ubuntu/release-manual.tar.gz
trap 'rm -rf "$S"' EXIT
bash "$S/scripts/deploy-ec2.sh" "$S" manual
EOF
```

`scripts/deploy-ec2.sh` (run on the host) does, in order: `flock /home/ubuntu/.deploy.lock`; free-space check; back up `.env` and every top-level entry it is about to touch to `/home/ubuntu/releases/<ts>.tgz` (last 5 kept); log any vertical files present on the host but absent from the release; `rsync --delete` each top-level entry of the release into place **except** that `app/routes/verticals`, `app/public/verticals`, `app/services/verticals` and `config/customers` are never deleted from (so a demo merged in only one repo keeps working until the sync PR lands) and `.env*`, `.ssh`, `certbot/`, `docker-compose.override.yml`, `archive/`, `releases/` are never touched; `scripts/host-bootstrap.sh` (below); `docker compose build checkout-api`, then `build loadgen` (one at a time — parallel builds OOM-hung the 1.9G host), `up -d --no-deps checkout-api`; wait for `/health`; GET every `app/public/verticals/*.html` slug, every alias and a fixed critical list (`/`, `/retail`, `/api/verticals`, `/oncall`, …) and require 200 from all; then restart loadgen and `docker compose up -d`. Any failure after the sync step restores the backup, rebuilds, and emails via `scripts/ops-notify.sh` (SNS topic `devindemos-alerts`, published with the instance's IAM role — no secrets in `.env`; the app's Slack channel is customer-facing and is not used for host ops). Exit code is non-zero on failure so the workflow run goes red.

**Host bootstrap.** `scripts/host-bootstrap.sh` is idempotent and runs on every deploy (and can be run by hand): it ensures a 2G `/swapfile` (fstab + `vm.swappiness=10`), persistent journald capped at 200M, `python3-boto3` for `scripts/ops-notify.sh` (warns if it or the instance IAM role is missing), and a single `*/5` cron entry for `scripts/vertical-guard.sh`, removing the legacy per-vertical `~/*-guard.sh` cron lines. Privileged steps use `sudo -n` and are skipped with a warning if passwordless sudo is unavailable.

**Vertical guard.** `scripts/vertical-guard.sh` (cron, every 5 min) GETs `/health` plus the demo pages the old guards watched on `127.0.0.1:3000` (`GUARD_PATHS`, `GRACE_SECONDS`, `COOLDOWN_SECONDS` are process-environment knobs for manual runs — cron does not read `.env`). It **never builds an image**: it skips while `.deploy.lock` is held and for 15 min after the last deploy (`releases/CURRENT`), and on a non-200 it does `compose up -d --no-build` then `compose restart` for `checkout-api`, at most once per 10 min, emailing via `scripts/ops-notify.sh` if that does not recover. Missing vertical files are reported the same way, not "repaired" — a redeploy owns the tree. Logs to `/home/ubuntu/vertical-guard.log`.

**Memory limits.** Every service in `docker-compose.yml` has a `deploy.resources.limits.memory` ceiling (2–5x steady state) so a leaking container is OOM-killed and restarted by Docker instead of taking the host down.

**Repo sync.** `.github/workflows/sync-repos.yml` (identical in both repos) runs on every push to `main` and every 6h: it force-pushes this repo's `main` to `sync/from-<org>` in the sibling repo, opens (or reuses) a PR there, and merges it when GitHub reports it mergeable; it is a no-op when the sibling already has an identical tree, which is what stops the ping-pong. On conflict the PR is left open, Slack is pinged and — if `DEVIN_API_KEY` is set — a Devin session is started to resolve it (keep both sides for anything under the vertical directories). Needs the `SYNC_GH_TOKEN` Actions secret in each repo with Contents + Pull requests + Workflows write on the *other* repo.

### Important Notes

- **`.env` location:** The production `.env` file lives at `/home/ubuntu/.env` on EC2. It contains all secrets (`SENTRY_DSN`, `DD_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `DOMAIN_NAME`, `CERT_EMAIL`, etc.) and must never be overwritten or deleted.
- **SSL certificates:** Stored in `./certbot/conf/` on EC2. These persist across deploys — the tarball and deploy workflow explicitly exclude this directory. Never delete this directory or you'll need to re-run `scripts/init-ssl.sh`.
- **Backup before deploy:** Always back up `.env` before extracting the tarball. If the `.env` is accidentally removed, Slack alerts, Sentry, and Datadog will silently stop working.
- **Port conflicts:** If `docker compose up` fails with port-in-use errors, run `docker compose down` first or `docker rm -f $(docker ps -aq)` to clean up stale containers from previous deployments.
- **Old deploy path:** An earlier deployment used `/home/ubuntu/acme-demo/` as the app directory. If you find a `.env` at that path but not at `/home/ubuntu/.env`, copy it: `cp /home/ubuntu/acme-demo/.env /home/ubuntu/.env`.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the Express app |
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm run lint` | Run ESLint |
| `npm run pipeline:a693dab5` | Run the Fleet Health Console pipeline headlessly |
| `npm run test:a693dab5` | Run the Fleet Health Console pipeline tests |
| `npm run test:a693dab5:contract` | Run the schema contract demo suite (excluded from `npm test` via `.demo-test.js`) |
| `npm run loadgen` | Run traffic generator standalone |
| `npm run features:build` | Rebuild the Kroger offer-affinity feature view from its spec |
| `npm run features:check` | Fail if the committed feature artifact is stale relative to the spec |
| `npm run audit:kroger` | Score every membership tier through the ranker (exits 1 on any coverage gap) |
| `npm run audit:zelle` | Probe send/request limit profiles (exits 1 on unresolved or downgraded rows) |
| `npm run feed:build` | Rebuild the SPGI feed field contract from its mapping spec |
| `npm run feed:check` | Fail if the committed feed contract is stale relative to the spec |
| `npm run audit:spgi` | Drive every instrument class through the parity harness (exits 1 on any uncovered class) |
| `npm run patrol:digest -- findings.json` | Format a validated Slow Query Patrol Slack digest |
| `npm run patrol:before-after -- --before URL --after URL --path PATH --runs N [--pause MS]` | Compare pre-fix and fixed patrol job responses |
| `npm run patrol:compare-page -- --before URL --after URL --path PATH [--port N]` | Serve a labelled side-by-side page of both patrol job responses |
| `npm run demo:trigger` | Trigger an error scenario |
| `npm run demo:reset` | Reset to healthy state |
| `npm run demo:warmup` | Pre-warm the app |
| `npm run demo:cleanup` | Clean up resources |

## Conventions

- **CommonJS modules** — Use `require()` and `module.exports`, not ES module syntax.
- **Structured logging** — Use the Winston logger (`require('../telemetry/logger')`) for all log output. Do not use `console.log` in app code.
- **Environment variables** — All secrets and configuration come from env vars. Never hardcode credentials.
- **Error handling** — Errors are captured with `Sentry.captureException()` and logged with the structured logger. Metrics are recorded via Datadog StatsD.
- **Lint before commit** — Always run `npm run lint` before committing. The ESLint config uses flat config format (`eslint.config.mjs`).
- **No force pushes** — Never force push. Use new commits to fix issues.
- **Prefix unused params** — Prefix unused function parameters with `_` (e.g. `_req`, `_next`) to satisfy the ESLint `no-unused-vars` rule.

## Testing

Unit tests live in `tests/` and run with `npm test` (Jest). Most verification is still done manually:

1. Run `npm start` or `docker compose up`
2. Open `http://localhost:3000` in a browser — you'll see the hub landing page
3. Click any vertical card to open its demo
4. Perform the primary action for that vertical (e.g., transfer funds, execute trade, submit claim)
5. Verify error appears (before fix) or action succeeds (after fix)
6. Check Sentry for captured exceptions
7. Check Datadog for APM traces and metrics
8. Check Slack for alert messages (if configured)

### Vertical URLs for Quick Access

When the app is running (locally at `localhost:3000` or on EC2 via `https://<DOMAIN_NAME>`):

| Vertical | URL |
|----------|-----|
| Hub | `https://<DOMAIN_NAME>/` |
| Retail | `https://<DOMAIN_NAME>/retail` |
| Banking | `https://<DOMAIN_NAME>/banking` |
| Financial Services | `https://<DOMAIN_NAME>/financial-services` |
| Insurance | `https://<DOMAIN_NAME>/insurance` |
| CPG | `https://<DOMAIN_NAME>/cpg` |
| High Tech | `https://<DOMAIN_NAME>/hightech` |
| Industrials | `https://<DOMAIN_NAME>/industrials` |
| Healthcare | `https://<DOMAIN_NAME>/healthcare` |
| Telco | `https://<DOMAIN_NAME>/telco` |
| Payer (welcome season) | `https://<DOMAIN_NAME>/welcome-season` |

## External Integrations

| Service | Purpose | Config |
|---------|---------|--------|
| Sentry | Error tracking, alert rules, webhooks | `SENTRY_DSN`, `SENTRY_ORG_SLUG` |
| Datadog | APM, metrics, logs, dashboard | `DD_API_KEY`, `DD_SITE` |
| Slack (`#automated-alerts`) | Alert notifications, Devin triggering | `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN` (slack mode), `SLACK_CHANNEL_ID` |
| [Devin API](https://api.devin.ai) | Direct session creation (api mode) | `DEVIN_API_KEY` |
| Datadog Dashboard | checkout-api overview | `DD_DASHBOARD_URL` |

## Common Tasks

### Adding a new API endpoint
1. Create a route file in `app/routes/`
2. Mount it in `app/server.js`
3. Add structured logging and Sentry/Datadog instrumentation
4. Run `npm run lint`

### Modifying the Slack alert format
Edit `buildAlertBlocks()` in `app/services/slack.js`. The function returns Slack Block Kit JSON. See [Block Kit Builder](https://app.slack.com/block-kit-builder) for visual editing.

### Modifying the Devin investigation prompt
Edit `buildPrompt()` in `app/services/devin-session.js`. The prompt uses GFM Markdown tables for structured data. Keep it detailed — this is the only context Devin gets when starting an investigation.

### ServiceNow incident trigger (per-customer `itsm: 'servicenow'`)
For an opted-in customer, a failure opens a P2 ServiceNow incident with `correlation_display=event-driven-devin`.
The ServiceNow business rule receives the incident and calls the Devin Automation webhook.
Devin investigates and opens a reviewable PR rather than deploying directly.
Incident work notes remain the durable record of the investigation and PR outcome.

### Adding a new customer demo
A new vertical touches only its own files; do **not** edit `app/routes/verticals/index.js`, `config/customers.js`, or `docker-compose.yml`. This is what lets both source repos (COG-GTM and Custom-Devin-Demos) deploy to the same host without unregistering each other's demos.
1. Create `config/customers/<slug>.js` (the file name is the slug):
   ```js
   module.exports = {
     label: 'Acme Corp',
     triggerMode: 'api',
     aliases: ['acme'],      // optional friendly URL(s) → /<slug>.html
   };
   ```
2. Add the page `app/public/verticals/<slug>.html` (served at `/<slug>` automatically) and, if the demo has an API, `app/routes/verticals/<slug>.js` exporting an express Router (mounted automatically) plus its service under `app/services/verticals/<slug>.js`.
3. Pass `customer: '<slug>'` in the vertical's `alertData` when calling `createSessionAndAlert()`.
4. Set the customer's env vars (suffixed with `_<SLUG>`) in the host `.env` and document them in `.env.example`:
   ```
   DEVIN_SERVICE_KEY_ACME=dv-abc123...
   DEVIN_USER_ID_ACME=...
   ```
   `checkout-api` loads the whole `.env` via `env_file`, so no `docker-compose.yml` entry is needed.
5. Run `npm test -- tests/verticals-registry.test.js` — it verifies the page, alias, and config are all wired.

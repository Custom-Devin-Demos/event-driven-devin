# Payer Welcome-Season RxBIN Defect — Vertical Wiki

Reference documentation for the `payer` vertical. The presenter-facing script lives in
[`DEMO-WELCOME-SEASON.md`](DEMO-WELCOME-SEASON.md); this page is the engineering and
narrative background behind it.

- [1. Scenario](#1-scenario)
- [2. Why this scenario exists](#2-why-this-scenario-exists)
- [3. Business and clinical impact](#3-business-and-clinical-impact)
- [4. Domain model](#4-domain-model)
- [5. Architecture](#5-architecture)
- [6. The defect](#6-the-defect)
- [7. Telemetry and alert path](#7-telemetry-and-alert-path)
- [8. Act 1 — reactive remediation and fan-out](#8-act-1--reactive-remediation-and-fan-out)
- [9. Act 2 — the pre-season prevention sweep](#9-act-2--the-pre-season-prevention-sweep)
- [10. Playbook](#10-playbook)
- [11. Running it locally](#11-running-it-locally)
- [12. Verification commands and expected output](#12-verification-commands-and-expected-output)
- [13. Known limitations and open decisions](#13-known-limitations-and-open-decisions)
- [14. Extending the vertical](#14-extending-the-vertical)

---

## 1. Scenario

A health plan loads plan configurations for the new plan year in the autumn ("welcome
season"), prints member ID cards from them in November, and the cards take effect on
January 1. One plan's configuration carries a **seven-digit RxBIN** — `0044336` instead of
`004336`. Pharmacy BINs are six-digit ANSI-assigned issuer identification numbers, so no
processor claims that value.

Nothing catches it:

- the card renders correctly and looks legitimate to the member, the call center, and the pharmacist;
- no service is unhealthy, so no infrastructure monitor fires;
- the failure only manifests at 00:00 on January 1, when the first claim is routed.

From that moment, essentially every pharmacy claim for the affected population rejects at
the counter. Members are asked to pay cash for medication they have coverage for.

The vertical is modelled on a real 2025 welcome-season defect in which a payer printed
NC State Health Plan cards with an invalid RxBIN. All member records, plan configurations,
and claim history in this repo are synthetic.

## 2. Why this scenario exists

Most demo incidents in this repo are infrastructure or code failures with an obvious
telemetry signature. This one is deliberately different, and that difference is the point:

| | Typical incident | This incident |
| --- | --- | --- |
| Signal | error rate, latency, crash | **business metric** — claim rejection rate by plan |
| Location | service code or infrastructure | **configuration data** |
| Infra alerts | fire | **none — every service is healthy** |
| Deliverable | restore the service | **merged code fix + prevention control + member remediation** |
| Best outcome | faster MTTR | **the incident never happens** |

An alert-correlation or root-cause-diagnosis tool has nothing to correlate here: there is no
anomaly in the observability stack, and the last mile (writing the validation, the tests, the
sweep, the member comms) is the work. The scenario is chosen where writing code and acting
before an incident decide the outcome.

## 3. Business and clinical impact

Ballpark for ~300,000 affected members and a defect not fully cleared for three to four weeks:

| Item | Estimate |
| --- | --- |
| Rejected first fills | ~120,000 (≈40% of members fill in January — peak month, deductible reset) |
| Call center | ~$0.9M (~70k extra calls × ~$12) |
| Card reprint and remail | ~$0.5M |
| Near-term script abandonment | ~3,000–4,000 scripts |
| Permanent leakage to competitors | ~1,500–2,000 patients → ~$0.3M/yr recurring gross profit |
| **Hard cost** | **~$1.5–2M**, plus performance-guarantee fee-at-risk |
| Tail risk | state-government book at renewal, ~$7–8M/yr in ASO administrative fees behind it |

The clinical dimension is why the demo formulary is specialty and time-critical therapy
rather than a maintenance drug. The default claim is **imatinib 400mg** for chronic myeloid
leukemia: a $50 copay becomes **$2,438.60 cash** at the counter, and a member who walks away
has interrupted a daily oral chemotherapy course, which does not always resume where it left
off. The selector also offers palbociclib (metastatic breast cancer, $16,204.85 cash),
ondansetron ODT (chemotherapy-induced nausea) and insulin glargine (type 1 diabetes), so the
stakes do not depend on one cherry-picked drug.

## 4. Domain model

### Pharmacy routing

A pharmacy claim is routed by three fields printed on the member's card:

| Field | Meaning | Validity |
| --- | --- | --- |
| **RxBIN** | Bank Identification Number — identifies the claim processor | exactly 6 numeric digits, must exist in the processor registry |
| **RxPCN** | Processor Control Number — selects the adjudication platform/plan within the processor | alphanumeric, must be one the processor accepts on that BIN |
| **RxGRP** | Group identifier — the employer/plan group | alphanumeric |

`PAYER_REGISTRY` in `app/services/verticals/payer.js` is the registry of routable BINs:

| RxBIN | Processor | Accepted PCNs |
| --- | --- | --- |
| `004336` | CVS Caremark | `ADV`, `ASPROD1`, `MCAIDADV` |
| `610591` | Aetna Pharmacy Management | `ADV`, `RXCOMM` |
| `610502` | Aetna Medicare Part D | `MEDDADV` |

### Plan configurations

`PLAN_CONFIGS` holds the 2026 plan year, all effective `2026-01-01`:

| Plan | RxBIN | RxPCN | RxGRP | Members | Status |
| --- | --- | --- | --- | --- | --- |
| `NCSHP-7030` | `0044336` | `ADV` | `RX8834` | 187,400 | **defective — 7 digits** |
| `NCSHP-8020` | `0044336` | `ADV` | `RX8835` | 112,600 | **defective — 7 digits** |
| `COMM-PPO-2026` | `610591` | `ADV` | `RX2041` | 421,900 | healthy |
| `MED-ADV-2026` | `610502` | `MEDDADV` | `MEDRX01` | 268,300 | healthy |

Two plans are defective on purpose. The alert only names the one whose member filled first;
the sweep finds the other. That is the moment that shows why blast-radius work belongs in the
remediation and not in a follow-up ticket.

### Members

| Member ID | Name | Plan | Outcome at the counter |
| --- | --- | --- | --- |
| `MEM-100234` | Sandra Whitfield | `NCSHP-7030` | rejects |
| `MEM-100891` | Marcus Ellison | `NCSHP-8020` | rejects |
| `MEM-200145` | Dana Okafor | `COMM-PPO-2026` | pays |

## 5. Architecture

```
app/public/verticals/payer.html      member portal + pharmacy counter + rejection chart
        │  fetch
app/routes/verticals/payer.js        GET  /api/payer/members
        │                            GET  /api/payer/id-card/:memberId
        │                            GET  /api/payer/rejection-series
        │                            POST /api/payer/pharmacy-claim
        ▼
app/services/verticals/payer.js      PAYER_REGISTRY, PLAN_CONFIGS, MEMBERS, FORMULARY
        │                            generateMemberIdCard()  ← prints routing fields onto cards
        │                            adjudicateClaim()       ← resolves BIN → processor
        │
        ├──▶ app/telemetry/{sentry,datadog,logger}
        └──▶ app/services/devin-session.js → Slack alert + Devin session

scripts/welcome-season-sweep.js      pre-print validation gate (Act 2), reuses the same registry
tests/payer-bin-validation.test.js   22 tests over adjudication, card generation, sweep
```

The page is served at both `/verticals/payer.html` and the friendly alias
**`/welcome-season`**. It is intentionally **not** registered in the hub `VERTICALS` array:
the hub is on screen during customer demos and this vertical is plan-branded, so it is
reachable by direct URL only.

### Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/payer/members` | roster plus the formulary (name, indication, copay, cash price, clinical note) |
| `GET` | `/api/payer/id-card/:memberId` | the card as printed; `404` for an unenrolled member, `500 PLAN_CONFIG_MISSING` when an enrolled member's plan config is absent |
| `GET` | `/api/payer/rejection-series` | seeded daily rejection rate spanning the plan-year boundary |
| `POST` | `/api/payer/pharmacy-claim` | adjudicates; `200` paid, `404 MEMBER_NOT_FOUND`, `500 CLAIM_REJECTED` with `rejectCode` / `rejectReason` / `submittedBin` |

A rejected claim returning `500` is this repo's convention: it is what raises the exception
that Sentry captures and that starts the Devin session. In a real integration a deterministic
NCPDP reject would be a `200` carrying a reject envelope.

## 6. The defect

`generateMemberIdCard()` copies `rxBin` / `rxPcn` / `rxGroup` from the plan configuration onto
the card **without validating them**. Nothing between data entry and the print run asserts
that the BIN is routable. `adjudicateClaim()` then does:

```js
const processor = PAYER_REGISTRY[card.rxBin];

routingLookupFailed = !processor;
const routedTo = processor.name;      // TypeError when the BIN is unroutable
```

For `0044336` the registry lookup returns `undefined` and dereferencing `.name` throws a
`TypeError`, which the catch block enriches with NCPDP reject metadata:

```js
if (routingLookupFailed) {
  error.rejectCode = '06';
  error.rejectReason = 'M/I Group Number — RxBIN not found in processor registry';
  error.submittedBin = card.rxBin;
}
```

Two properties of this shape are deliberate:

1. It is the **same bug class the other verticals use** (an undefined lookup dereferenced), so
   it behaves identically in Sentry while telling a data-defect story rather than a crash story.
2. Enrichment is gated on `routingLookupFailed`, so a future unrelated throw inside the try
   surfaces as a plain `ADJUDICATION_FAILED` instead of masquerading as a pharmacy reject.

The root cause has two halves, and the fix has to name both: **the bad value in the plan
configuration**, and **the missing validation that let it reach a printed card**.

## 7. Telemetry and alert path

```
POST /api/payer/pharmacy-claim
  └── adjudicateClaim() throws
        ├── incrementMetric('pharmacy_claim.rejected', { route, planId, errorClass, rejectCode })
        ├── recordTiming('pharmacy_claim.latency', … , { error: 'true' })
        ├── logger.error('Pharmacy claim adjudication failed', { claimId, rejectCode, submittedBin, … })
        ├── Sentry.captureException(error, { tags: { planId, rejectCode, … } })
        └── createSessionAndAlert({ …, promptAppendix: FANOUT_DIRECTIVE })
              ├── Slack alert in the configured channel
              └── Devin session via the Devin API
```

`pharmacy_claim.rejected` is tagged by `planId`, which is what makes the blast radius
knowable — untagged, the metric spikes but cannot be broken down, and you cannot tell one
plan from the whole book. The paid path emits `pharmacy_claim.paid` with the same `planId` tag.

`promptAppendix` is a hook in `app/services/devin-session.js` that appends scenario-specific
directives to the standard investigation prompt. It is only ever populated from
`FANOUT_DIRECTIVE`, a module constant — no request-supplied field is ever forwarded into it,
and it must stay that way, since the prompt is appended verbatim.

Live Slack and Devin delivery requires `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and
`DEVIN_API_KEY` on the host (plus `SENTRY_DSN` / `DD_API_KEY` for Sentry and Datadog). Without
them the member-facing acts and the sweep still work; only the alert and fan-out do not.

Known asymmetry: a session created through the Sentry **webhook** fallback path does not carry
the payer prompt appendix, because the appendix is attached at the adjudication call site.

## 8. Act 1 — reactive remediation and fan-out

`FANOUT_DIRECTIVE` instructs the triage session to run four workstreams **in parallel as child
sessions**, then summarize. They are genuinely independent — different files, different
branches, no shared contract:

| # | Workstream | Deliverable |
| --- | --- | --- |
| 1 | **Card-generation fix** | validate RxBIN/RxPCN/RxGRP against `PAYER_REGISTRY` before a card is issued, fail loudly on an unroutable BIN, regression test for the 7-digit case → PR |
| 2 | **Blast-radius sweep** | audit every entry in `PLAN_CONFIGS`, report each failing plan and the member count, wire the sweep into CI → PR |
| 3 | **Adjudication bridge** | temporary routing alias so claims presenting the bad BIN adjudicate correctly while cards reprint, with an expiry and rollback path |
| 4 | **Member impact and comms** | affected-member list triaged so specialty and oncology members are contacted first, pharmacy help-desk script for the reject code, JIRA ticket covering root cause, remediation, and the prevention control |

The directive also tells the triage session explicitly that every service is healthy and no
infrastructure alert fired, so it does not waste time hunting for an infrastructure cause.

Ordering matters in the narrative: workstream 3 is what stops members being harmed **today**;
workstream 1 stops the next occurrence. Reprinting cards is cleanup, not remediation.

## 9. Act 2 — the pre-season prevention sweep

`scripts/welcome-season-sweep.js` is the control that makes the incident not happen. It runs
against plan configurations before cards are printed and, for every plan effective January 1
of the given plan year, checks:

1. RxBIN present;
2. RxBIN numeric;
3. RxBIN exactly six digits;
4. RxBIN present in `PAYER_REGISTRY`;
5. RxPCN well-formed;
6. RxGRP well-formed;
7. the processor accepts that PCN on that BIN;
8. a **synthetic claim** against the configuration adjudicates end to end.

Exit codes, deliberately fail-closed:

| Exit | Meaning |
| --- | --- |
| `0` | every plan validated — cards are safe to print |
| `1` | at least one plan would reject at the counter, **or** zero plans matched the requested year |
| `2` | malformed `--plan-year` argument |

Exit 1 on "zero plans matched" is the important one: a typo in the year must never let the
pre-print gate report a silent pass. Both `--plan-year 2026` and `--plan-year=2026` are accepted.

Operationalized, this is a scheduled Devin run each October through December across the whole
book — not one client — which turns a ~$2M incident into a corrected spreadsheet cell.

## 10. Playbook

The triage and fan-out procedure is available as a reusable Devin playbook,
**Welcome-Season Pharmacy Routing Defect — Triage and Fan-Out** (macro `!welcome_season_triage`).
It generalizes past this repo to any business-metric step at an effective date with no
matching infrastructure signal: restate impact, rule out infrastructure, locate the routing
data, name the root cause as value + missing control, fan out the four workstreams, verify
(tests, lint, sweep, and a recorded browser walkthrough of the member flow), reconcile, convert
the sweep into a scheduled control, and post the summary.

Using it in the demo makes the fan-out reproducible rather than a one-off prompt: the same
four workstreams appear whether the session starts from the Slack alert or from an operator
typing the macro.

## 11. Running it locally

```bash
npm install
PORT=3011 node app/server.js
# then open http://localhost:3011/welcome-season
```

Expected member flow:

1. Sandra Whitfield's card loads with RxBIN `0044336` highlighted, and the note explains the digit count.
2. The medication selector defaults to imatinib 400mg for chronic myeloid leukemia.
3. Submitting the claim returns `REJECT 06`, submitted RxBIN `0044336`, and the amber panel showing $2,438.60 cash against a $50 copay plus the clinical note.
4. Switching to Dana Okafor and submitting pays, routed to Aetna Pharmacy Management.
5. The chart shows ~2.1% baseline through 12/31 and ~95.3% from 01/01, with "no infrastructure alert fired".
6. The submit button stays disabled whenever a card is not loaded.

The app is stateless — reload to reset. Each submitted claim raises a fresh alert and session.

## 12. Verification commands and expected output

```bash
npm test                                        # 22 passing tests, 2 suites
npm run lint                                    # 0 errors, 2 pre-existing warnings
node scripts/welcome-season-sweep.js            # exit 1 — NCSHP-7030 and NCSHP-8020 fail
node scripts/welcome-season-sweep.js --plan-year 1999   # exit 1 — no plans matched, fails closed
node scripts/welcome-season-sweep.js --plan-year        # exit 2 — malformed argument
```

The two lint warnings are pre-existing and unrelated to this vertical: an unused
`postDevinReply` in `app/services/slack.js` and an unused `_err` in `scripts/warmup.js`.

## 13. Known limitations and open decisions

- **Reject code `06` is provisional.** In NCPDP, `06` is "M/I Group Number", whereas an
  unroutable BIN would normally reject as `01` ("M/I BIN"). `06` is quoted in the UI, the run
  sheet, the talk track, and the help-desk workstream, so it is a one-line change once a
  pharmacy SME confirms. **Awaiting a human decision — do not switch it unilaterally.**
- **The rejection-rate series is seeded**, not queried from Datadog. Historical December-vs-January
  time series could not be backfilled into a real Datadog account quickly; live metrics still flow.
- **Live Slack → Devin fan-out is unverified from the build environment** — it requires host
  credentials that were never provisioned here. The code path is the repo's existing, exercised one.
- **The Sentry webhook fallback path does not carry the payer prompt appendix**, so a session
  created that way gets the generic investigation prompt without the four workstreams.
- **`uuid` is pinned to `9.0.1`.** `uuid@13` is ESM-only and `require('uuid')` throws on the
  Node 20 runtime the Dockerfile targets, which broke startup for *every* vertical. Moving the
  runtime to Node 22 (and unpinning) is a separate decision.
- **All data is synthetic**: member names, plan configurations, claim history, and prices are
  fabricated for demonstration.

## 14. Extending the vertical

- **Make the fix deterministic for a demo** by changing both NC State Health Plan entries in
  `PLAN_CONFIGS` from `rxBin: '0044336'` to `'004336'`; the claim then pays and the sweep
  passes. Change it back to leave the defect for Devin to fix live.
- **Add a plan** to `PLAN_CONFIGS` (and a member to `MEMBERS`) to widen the blast radius; the
  sweep and the tests pick it up automatically.
- **Add a defect class** — an unsupported PCN, or a malformed RxGRP — the sweep already
  validates both, so a new plan with `rxPcn: 'MEDDADV'` on BIN `004336` fails for a different
  reason than the digit count.
- **Wire the sweep into CI** as a required check, which is what workstream 2 is meant to produce.
- **Schedule the sweep** as a recurring Devin automation over the pre-print window to turn the
  prevention story into something the customer runs, not something they watch.

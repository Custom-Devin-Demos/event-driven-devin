# Caterpillar — Dealer Service DW demo (`/a70e8270`)

## What I built

A Caterpillar-branded batch-operations console for the **Dealer Service Data Warehouse**. It is unlisted — reachable only at `/a70e8270` — and it shows the nightly Tidal job chain that turns closed dealer work orders into CVA coverage and parts-demand numbers:

1. `DEALER_DIM_SYNC` (01:30 CT) — copies `dbo.dealers` from DSMS (SQL Server) into `ANALYTICS.DIM_DEALER`.
2. `SMU_WORKORDER_DAILY_LOAD` (02:15 CT) — extracts work orders closed in the last 24 hours, resolves each dealer code to its sales district, computes SMU deltas per machine PIN, and loads `ANALYTICS.FACT_WORK_ORDER` in Snowflake (`DISTRICT_CD` is NOT NULL).
3. `CVA_COVERAGE_REFRESH` (03:00 CT) → 4. `PARTS_DEMAND_FORECAST` (03:30 CT) — both depend on step 2.

The page shows the job chain, tonight's pending batch (~200 closed work orders), six nights of run history, an extract preview from `dbo.work_orders`, the 40-dealer network, source/warehouse tables, and the fleet by model. The brand elements (wordmark, Cat yellow, black utility bar, condensed uppercase headings) come from public brand references; the console itself is a simulation, not a copy of any internal Caterpillar system.

## The story

Last Saturday, dealer territory **D-4417 Prairie State Machinery** was split. Two new dealer codes went live — **D-4418 (Quad Cities)** and **D-4419 (Central Illinois)** — and `DEALER_DIM_SYNC` picked them up correctly the same night. But the load job still resolves district through a hardcoded dealer → district table that was aligned in FY24. Those two codes aren't in it, the lookup returns nothing, and the first row from one of those dealers hits the `DISTRICT_CD` NOT NULL constraint. Snowflake rejects it, the whole batch rolls back, and steps 3 and 4 sit blocked.

The presenter clicks **Run SMU_WORKORDER_DAILY_LOAD now**. Nothing runs on page load or on a timer — the failure only happens on that click.

What happens in about a second:

- The job flips to **failed**, the two downstream jobs show **blocked**, `CVA_COVERAGE` and `PARTS_DEMAND_FORECAST` go **Stale**, and a toast shows `IntegrityError 100072 (22004): NULL result in a non-nullable column: ANALYTICS.FACT_WORK_ORDER.DISTRICT_CD`.
- Winston logs the failure with the batch id, the row counts, the failing row index and a full stack trace. Datadog gets `dw.job.failed`; Sentry gets the exception with job/batch/stage tags.
- A Slack alert lands in the on-call channel, tagging Nandu (`U0BDHHQUM24`), and a Devin session starts with the incident context. **Nothing in the logs or the alert names the two dealer codes** — Devin has to trace the null back through the transform to the mapping module and compare it against the dealer dimension to find them.

The fix Devin is asked for is deliberately not a one-liner: replace the drifting hardcoded lookup with the nightly-loaded dealer dimension, quarantine unresolvable rows to a reject table instead of failing the batch, add a test for a newly activated dealer, and re-run the batch.

## How to present it

- Open `/a70e8270`. Point at the green chain and the pending batch. Open the **Dealers** tab and scroll to D-4418/D-4419 — they carry a yellow "new · split from D-4417" badge with Saturday's activation date. That's the seed of the incident, visible to a human but not to the job.
- Click **Run SMU_WORKORDER_DAILY_LOAD now**. Walk the red/amber chain, then switch to Slack for the alert and the Devin session.
- The line I'd use: *"This didn't take a machine down. But CVA coverage reporting is stale this morning, and the demand signal is a day behind. One job. How many of these do you run a night?"*
- To rerun, the small **Reset console** button appears only after a failure; it re-seeds the history and the defect fires again on the next click.

## Endpoints

`GET /api/a70e8270/overview`, `GET /api/a70e8270/runs`, `POST /api/a70e8270/load/run`, `POST /api/a70e8270/load/reset`. Files: `app/services/verticals/a70e8270.js`, `app/services/verticals/a70e8270-dealer-mapping.js`, `app/routes/verticals/a70e8270.js`, `app/public/verticals/a70e8270.html`.

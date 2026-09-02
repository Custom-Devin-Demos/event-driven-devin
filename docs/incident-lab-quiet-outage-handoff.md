# Incident Lab rework: quiet outage, loud precursor, wrong IC — agent handoff

You are finishing a rework of the `flowforge-scheduled-workflows` Incident Lab scenario. The old version let Devin find root cause in ~6 minutes because the outage logs contained the exception name, file:line stack, and project slug, and the IC's scripted lines gave the theory away at minute 4. The new story fixes both. The scenario JSON and emitter in `event-driven-devin` are already updated, and the n8n fork commits already exist (see Part 1); your job is the Supabase seed data and Datadog verification.

## The new story (read first)

- The bug is unchanged: `S3BinaryDataManager.bucketForProject()` derives `<baseBucket>-<projectSlug>`, and `prj_meridianfx_eu` is the only slug with underscores — an invalid S3 bucket name on any backend. One failed upload aborts the whole tick's `Promise.all` in `ScheduleIngestService.offloadBatch`, cursors never advance, the occurrence re-matches every tick, all scheduled workflows stop. (There is deliberately no "bring-your-own storage" tier anywhere in the fiction: IR-113's investigator correctly pointed out the code has none, so personas and seed data no longer claim one.)
- New: outage-era worker logs are **redacted** (class name only, no provider message, no slug, no stack). Fiction: a logging-hygiene release deployed minutes before onset redacts provider error messages from queue worker logs because they may reference tenant storage resources.
- New: the **only loud evidence** is a burst of 8 pre-redaction errors from earlier that morning (the customer's manual test run of their new weekly export), with the full provider message, stack, and project slug. It dead-lettered after maxReceive=8 and self-resolved.
- New: the deploy marker lands at the same minute as onset. The IC blames the deploy. The deploy is innocent of the outage; it only muted the logs. Devin's job is to disprove the deploy theory, work the poison-batch pattern from metrics, read the fork, find the loud burst, and assemble root cause.

## Part 1 — n8n fork changes (ALREADY DONE — reference only)

Repo: `ananthv26-cog-demo-repos/n8n`, branch `flowforge-prod`. Two commits exist on top of the planted feature commits:

1. `feat(cli): Run schedule tick ingest as a redeliverable queue job (#37468)` — adds `packages/cli/src/scaling/schedule-ingest-job.ts` (plus test) whose catch logs the loud single line: error name, provider message, project slug, flattened stack.
2. `fix(cli): Keep tenant identifiers out of scaling worker logs (#37471)` — changes the failure logging to the withheld form ("cause redacted (may contain tenant data)"; no error class, no provider message, no slug, no stack, and no attempt counter — per-line random attempt numbers were a detectable fake in run A4IK0). The diff of this commit is the evidence trail Devin can dig up through the runner file's history. The commit subject is deliberately not searchable for "redact schedule-ingest", and a routine docs commit sits above it so `git log` doesn't lead with the answer.

The planted files `schedule-ingest.service.ts` and `s3.manager.ts` are untouched. Do not modify any of these files further. The scenario JSON's templates match the two log formats, and the burst's stack cites (`s3.manager.ts:87:11`, `schedule-ingest.service.ts:141:20`, `:96:9`) are verified against the branch.

## Part 2 — Supabase seed data

Devin (and Sam via JIT access) may query the demo Supabase during the incident. Inspect the existing schema first (list tables, then map), and upsert idempotently. The data must support these facts:

1. **Projects**: `prj_meridianfx_eu` exists (slug with underscores, EU region, org name MeridianFX). At least 5-8 other projects with dash/alphanumeric slugs (these are the innocent tenants sharing ticks).
2. **Tenant storage config**: uniform platform provisioning — every project gets `base_bucket = flowforge-artifacts` and a derived per-project bucket, matching the code. No BYO rows; the DB clue is the underscore slug itself.
3. **Workflows**: meridianfx has an active workflow named `Weekly Export` with a weekly schedule, created within the last week. Other projects have a spread of active scheduled workflows (hourly/daily) so a tick plausibly matches multiple projects, plus webhook/manual workflows that stayed healthy.
4. Optional but nice: an executions or queue/DLQ table showing 8 failed delivery attempts for one meridianfx job this morning, then dead-lettered — matching the loud burst.

Do not invent new tables if equivalents exist; conform to whatever the schema calls these things. After seeding, print the verification queries and their results (project slug, storage row, workflow schedule) so the presenter can eyeball them.

**Status:** seeded via `scripts/incident-lab/seed-flowforge-supabase.sql` into the `flowforge` schema of the incidents-demo Supabase (`SUPABASE_WAREHOUSE_URL`; the database had no equivalent tables — only `public.dim_sessions`, untouched). The script is idempotent and recomputes relative timestamps (Weekly Export created 5 days ago, this morning's dead-lettered job at now−2h), so it has to run shortly before arming for the DLQ rows to line up with the backdated burst — **Arm now replays it automatically** (the scenario's `warehouse.seedFile`, run by `app/services/incident-lab/supabase-seed.js` against `INCIDENT_LAB_WAREHOUSE_URL` or `SUPABASE_WAREHOUSE_URL`, reported on the run log), so no manual run is needed. The direct `db.<ref>.supabase.co` host is IPv6-only; from an IPv4-only box connect through the session pooler (`aws-0-us-west-1.pooler.supabase.com:5432`, user `postgres.<ref>`). The DLQ row records only the error class (`S3UploadError`), never the provider message or slug — the full message stays exclusive to the backdated burst.

## Part 3 — Datadog

**Subject-repo sweep at arm and stop:** with `INCIDENT_LAB_GITHUB_TOKEN` (or `GITHUB_TOKEN`) configured, arming and stopping a run each close open PRs whose head is a `devin/` branch on the scenario's own repo (heads on contributors' forks are left alone) and delete all `devin/` branches. Sweeping at arm as well as at stop covers the run that is never stopped — presenter closes the tab, a deploy restarts the box. Prefer a token scoped to the subject repo only: the sweep closes PRs and deletes refs. Closed PR pages keep their diffs — the best run's fix stays linkable as a golden artifact — while the refs disappear from clones and branch listings, so the next run's investigator never finds a ready-made fix. Without the token the sweep is skipped and logged; sweep manually before the next run.

**Per-run telemetry identity:** each run emits under its own service tag, `flowforge-orchestrator-<5-char suffix>` (the run ref's random segment, lowercased; shown in `GET /api/incident-lab/status` and in the incident summary as "Service: ..."). Prior runs' telemetry stays in Datadog under their own service names until log retention ages it out, so a rerun can't read yesterday's loud logs as evidence for today's incident. Scope all Log Explorer / metric queries to the current run's service.

Nothing is pre-seeded; the emitter writes everything at arm/declare. Verify:

1. The deployed `event-driven-devin` app has the updated scenario + emitter (redeploy per `AGENTS.md` deployment section; back up `.env` first).
2. No Datadog monitor exists on `flowforge.*` metrics or `service:flowforge-orchestrator` logs. "No alert fired" is a premise; a monitor firing mid-demo breaks it.
3. Rehearsal (recommended) — the control page's **Run** button does arm-then-declare on its own (declaring after the scenario's 3-minute lead-in, counted down on the page), so step through it by hand only when you want to inspect the armed state for longer: `POST /api/incident-lab/arm` with header `X-Lab-Token: $INCIDENT_LAB_TOKEN` and body `{"scenario":"flowforge-scheduled-workflows"}`. After ~2 minutes, confirm in Log Explorer (`service:` the run's telemetry service from the status endpoint, time range: past 3 hours) that the 8-error loud burst appears with the full provider message, timestamped ~2h ago. Then `POST /api/incident-lab/declare`, confirm: one `flowforge.deploy` "Deployment complete" log backfilled ~60 min ago, redacted `flowforge.queue.worker` errors at ~480/hr across the past hour, `executions.started{trigger:schedule}` flat near zero for an hour while `trigger:webhook` is healthy. Then `POST /api/incident-lab/stop` (resolves the Datadog incident).

## Part 4 — Run-of-show constraints (tell the presenter)

- **Run declares 3 minutes after arming** (`leadInMs` in the scenario JSON). The bounds below are what that lead-in has to stay inside if you change it.
- **Arm 2–55 minutes before declaring.** The loud burst is written 1 minute after arm with timestamps backdated 2 hours, so it always predates the backfilled deploy marker (declare minus ~60 min) — no long lead is needed for that. Arming also backfills ~3 hours of healthy baseline **logs** ending at the projected outage start, so the investigator has a "before" to correlate against without any extra waiting (run A4IK0's Devin correctly complained none existed). A healthy metric "before" is not possible — metric intake only accepts ~1h-old points and the outage window spends them — so the before lives in logs only. While armed, the sink withholds the baseline specs that onset retroactively replaces (schedule-triggered `executions.started`/`executions.completed`, the "Enqueued execution batch … advanced schedule cursors" success log) because intake cannot retract them once onset backfills the last hour at declare; the rest of the healthy noise emits live. Onset backfills those metrics for 55 minutes, so an arm lead beyond that leaves a gap in the schedule-execution series between arm and the backfill window.
- Mitigation fires automatically from Sam's scripted line at ~50 min; no manual phase trigger needed. The scripted timeline is front-loaded — the opening beats land ~3x faster than authored pacing so the channel reads like the first minutes of a real incident — but the beats that give the mechanism or the culprit away sit late on purpose (the IIUC recap at ~35 min, the fix task at ~40 min, mitigation at ~50 min), so an unsupervised run never outruns the investigator. The director's `advance` is what pulls them forward when the investigator is ahead; the last line lands at ~100 min.
- The mitigation beat is the one beat the director may hold for up to 20 minutes (ordinary beats: 4), because it both names the culprit and recovers the telemetry — it should land after the investigator's finding, not before it.
- Mitigation now also silences the failure telemetry (IR-113's investigator declared the incident "still active" because failure logs kept flowing at the pre-mitigation rate after Sam's disable line). Outage failure ids cycle through a 15-job pool reused 8 times so redelivery cadence looks real (753 single-use ids was a tell), and the precursor burst carries matching cursor warnings so the pre/post-deploy code paths read identical.
- Nobody in the channel should name times of day; the telemetry only spans hours, not "since 8AM". The scripted lines already respect this.

## Acceptance checklist

- [ ] Fork: runner commit + redaction commit on `flowforge-prod`; planted service/manager files untouched
- [ ] Fork log formats match the scenario JSON templates (grep for "returning to queue" and "cause redacted" from the repo root and land in the runner)
- [ ] Stack-trace line numbers in the burst template verified against the fork
- [ ] Supabase: meridianfx project (underscore slug), uniform platform storage rows, Weekly Export workflow, other tenants with schedules
- [ ] Deployed app serves the new scenario (`GET /api/incident-lab/status` lists it)
- [ ] No monitors on flowforge telemetry
- [ ] Rehearsal run: loud burst while armed, quiet errors + deploy marker backfilled at declare, incident auto-resolved on stop

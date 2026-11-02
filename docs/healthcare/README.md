# Healthcare Demo Lab — AD runbooks

Four healthcare demos built on the event-driven Devin loop. Each one is a realistic customer app with one hidden production bug. An AD clicks the main button, the app fails, and within seconds:

1. the error lands in **Sentry**,
2. failure metrics land in **Datadog**,
3. an **alert card** is posted in Slack,
4. a **Devin session** starts on its own, reads the alert, finds the bug and opens a **fix PR**.

Start at **`/healthcare-lab`** and pick a story.

| Segment | Story | Path (aliases) | What breaks |
|---|---|---|---|
| Payer | Summit Health Plan — prior authorization | `/ff0485e4` (`/hc-payer`, `/prior-auth`) | MRI request at an outpatient hospital crashes |
| Provider | Lakeshore Health — patient appointment intake | `/3a2b7a6d` (`/hc-provider`, `/patient-intake`) | Booking a video visit fails |
| Pharma | Veloria — Veloxa copay savings card | `/46ce04a1` (`/hc-pharma`, `/copay-card`) | Savings card fails on a 90-day fill |
| Life Sciences | Helix Clinical Research — trial lab data pipeline | `/27a970ec` (`/hc-lifesciences`, `/trial-pipeline`) | Toronto site's lab batch fails to load |

All brands, people and products are fictional and all data is synthetic (no PHI). Existing healthcare demos (`/healthcare`, `/tenet`, `/c65e3d81`, `/907b82bd`, `/86a0a4f9`, `/fcf0f903`, `/7c6a6ef9`) are unchanged.

**Before you present (all four):** have the Slack alert channel and the Devin sessions list open in other tabs. Every page is pre-filled so the bug fires on the first click — there is nothing to type.

**Reset (all four):** the demos keep no state. Reload the page and it is back to the pre-filled failing case. After Devin's fix PR is merged and deployed the bug is gone for good — to demo again, the PR must stay unmerged (or be reverted).

---

## 1. Payer — prior authorization (`/ff0485e4`)

**Trigger:** open `/ff0485e4` → leave the defaults (Jordan Rivera, CPT 72148 MRI, place of service *22 — Outpatient hospital*) → **Submit for review**.
**What you see:** red box “We couldn’t process this authorization request” with `TypeError: Cannot read properties of undefined (reading 'requiredDocs')`.
**Show that it's only one path:** switch place of service to *11 — Physician office* and submit — it is approved instantly.

**What Devin does next:** the alert names `app/services/verticals/ff0485e4.js — submitPriorAuth` and tags `cpt=72148`, `placeOfService=22`. Devin opens that file and sees the place-of-service code 22 becomes `outpatient-hospital` (hyphen), but the clinical-criteria rule was saved as `72148:outpatient_hospital` (underscore), so no rule is found. It fixes the key, adds a test and opens a PR.

**Point at on screen:** the error box → Slack alert card (service `ff0485e4-prior-auth-api`, CPT and place-of-service tags) → the Devin session thread → the one-line diff in the PR.

**Talk track (2 min):**
> “This is a health plan’s provider portal. A clinic wants approval for a back MRI at the hospital — one of the most common requests a payer gets. They press submit and… it breaks. In real life that request sits in limbo, the clinic calls provider services, and the patient’s scan slips a week.
> Nobody here filed a ticket. The moment that failed, the plan’s monitoring caught it and posted this alert in Slack — and Devin already picked it up. Watch the thread: it’s telling us which request broke and why. Turns out one rule was saved with a slightly different name than the system looks for, so hospital MRIs never matched. Office MRIs work fine, which is why nobody noticed.
> Here’s the pull request — a one-line fix, a test so it can’t come back, ready for the engineer to approve. For a payer with prior-auth turnaround rules, that’s minutes instead of a multi-day backlog.”

---

## 2. Provider — patient appointment intake (`/3a2b7a6d`)

**Trigger:** open `/3a2b7a6d` → leave the defaults (Jordan Rivera, Dr. Okafor, *Video visit (telehealth)*) → **Confirm appointment**.
**What you see:** “We couldn’t finish booking your appointment” with `TypeError: Cannot read properties of undefined (reading 'consents')`.
**Contrast:** switch Visit type to *In-person visit* — it books and lists the remaining check-in forms.

**What Devin does next:** the alert points to `app/services/verticals/3a2b7a6d.js — submitIntake` with tag `visitType=telehealth`. Devin finds the visit type is called `telehealth` but the intake forms list is filed under `virtual`, so there are no forms to send. It renames the key, adds a test and opens a PR.

**Point at on screen:** the patient-facing error → Slack alert card (`visitType: telehealth`) → Devin’s explanation in the thread → PR.

**Talk track (2 min):**
> “This is a hospital system’s patient portal. A patient is booking a video follow-up with their doctor — the kind of visit that’s become a huge share of primary care. They click confirm, and it fails. That patient either calls the front desk or just doesn’t book, and the health system loses the visit.
> The system didn’t wait for a complaint. The failure showed up in monitoring, posted here in Slack, and Devin started on it automatically. It’s found that video visits were renamed at some point, but the check-in paperwork was still filed under the old name — so every video booking breaks, while in-person visits keep working.
> Devin has already opened the fix. An engineer reviews and approves it; they didn’t have to dig through logs at 7 a.m. to find it.”

---

## 3. Pharma — copay savings card (`/46ce04a1`)

**Trigger:** open `/46ce04a1` → leave the defaults (card VLX-5520-1187, *Veloxa 90-day pack*, $1,350 out-of-pocket) → **Apply savings card**.
**What you see:** “Savings card could not be applied” with `TypeError: Cannot read properties of undefined (reading 'cardMax')`.
**Contrast:** choose *Veloxa 30-day pen* (amount changes to $450) — the patient pays $25.

**What Devin does next:** the alert points to `app/services/verticals/46ce04a1.js — calculateCopayBenefit` with `product=VLR-90` and the $1,350 amount. Devin sees the benefit tiers stop at $1,000, so the bigger 90-day amount matches no tier. It adds a top tier (or caps at the last one), adds a test and opens a PR.

**Point at on screen:** the pharmacy-counter error → Slack card → Devin session → PR.

**Talk track (2 min):**
> “This is the savings card program for a specialty brand. The pharmacist is ringing up a 90-day supply, which the brand just started covering this year. They apply the card and it’s rejected. The patient is now being quoted over a thousand dollars at the counter — that’s exactly when patients walk away from therapy, and the brand loses the script.
> This alert came straight from production, and Devin is already working on it. Its finding: the program’s savings tiers were set up for 30-day amounts. The new 90-day pack costs more than the top tier, so the system has nothing to apply. 30-day fills work, which is why nobody caught it in testing.
> The fix is in a pull request waiting for review. For a patient-services team, that’s the difference between a weekend of abandoned prescriptions and fixing it before the next pharmacy calls.”

---

## 4. Life Sciences — clinical-trial lab data pipeline (`/27a970ec`)

**Trigger:** open `/27a970ec` → leave *SITE-104 — Toronto Research Centre* → **Run ingest**.
**What you see:** “Ingest failed — batch not loaded” with `TypeError: Cannot read properties of undefined (reading 'factor')`.
**Contrast:** choose *SITE-101 — Boston Clinical Unit* — three records load into the study warehouse with range flags.

**What Devin does next:** the alert points to `app/services/verticals/27a970ec.js — ingestBatch` with `site=SITE-104`. Devin sees the Toronto lab reports glucose in mmol/L (the Canadian unit) and the pipeline only knows how to convert mg/dL. It adds the mmol/L conversion (×18.016), adds a test and opens a PR.

**Point at on screen:** the failed batch → Slack card (`site: SITE-104`) → Devin session → PR.

**Talk track (2 min):**
> “This is the data hub for a Phase III diabetes trial. Every day, lab results from each hospital site flow into the study database. The data manager runs today’s batch from the Toronto site and the whole batch fails. Those patients’ results don’t reach the study team — and with an interim data lock in eleven days, every day of missing data is a real problem.
> It went to Slack automatically, and Devin is already on it. What it found: the Canadian site reports blood sugar in a different unit than the US sites, and the pipeline only knew the US unit. US sites load fine, so this only showed up when Toronto came online.
> Devin added the conversion, wrote a test and opened the pull request. In a regulated environment the engineer still reviews and approves it — Devin just removed the hours of detective work.”

---

## What HC-GTM-AD still needs

The loop has two halves, and each needs its own settings:

- **A. The demo app** (wherever `event-driven-devin` is running for this lab) needs environment variables so a failure posts to Slack and starts a Devin session **in HC-GTM-AD**.
- **B. The HC-GTM-AD Devin org** needs secrets, MCPs and an automation so the session that starts can read Sentry/Datadog, reply in the Slack thread and open the PR.

HC-GTM (`org-3d8121bad421424394a794612fa2345e`) has the working setup. What HC-GTM-AD (`org-ad5cb75ed086403697e4d37f8411936e`) had when this was written: **no org secrets, no automations**. Installed integrations include Slack (plus GitHub and others); org-level MCP includes Datadog and Figma; there is **no Sentry MCP**. Nothing below has been changed by this PR — an org admin must do it.

### A. Demo app environment (on the server running this repo)

| Variable | Value / where to copy from | Why |
|---|---|---|
| `SLACK_BOT_TOKEN` | Same bot token HC-GTM uses (`SLACK_BOT_TOKEN` / `COG_GTM_DEMO_SLACK_BOT_TOKEN`) | Posts the alert card; without it the app logs `Slack not configured — skipping alert post` and **no Devin session is created** |
| `SLACK_CHANNEL_ID` | ID of the demo alert channel (`#automated-alerts` per `AGENTS.md`), or set `SLACK_CHANNEL_ID_<SLUG>` per demo | Where the card lands |
| `SLACK_TRIAGE_CHANNEL_ID` (optional) | `#automated-devin-triage` ID | Report-only mirror |
| `DEVIN_SERVICE_KEY_<SLUG>` (or global `DEVIN_SERVICE_KEY`) | **New** service-user API key created **in HC-GTM-AD** (HC-GTM's key would start sessions in HC-GTM) | Creates the session (`POST /v3/organizations/{org}/sessions`) |
| `DEVIN_ORG_ID_<SLUG>` | `org-ad5cb75ed086403697e4d37f8411936e` | Sessions start in HC-GTM-AD |
| `DEVIN_USER_ID_<SLUG>` (optional) | The presenting AD’s Devin user ID | Session shows up under that AD |
| `SENTRY_DSN`, `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_ID` | Same as HC-GTM's deployment | Error capture + “View in Sentry” link |
| `DD_API_KEY`, `DD_SITE`, `DD_ENV`, `DD_DASHBOARD_URL` | Same as HC-GTM's deployment | Datadog metrics + dashboard button |

`<SLUG>` is each of `FF0485E4`, `3A2B7A6D`, `46CE04A1`, `27A970EC` (all four are `triggerMode: 'api'`). Placeholders are in `.env.example`.

### B. HC-GTM-AD Devin org (copy from HC-GTM)

Secrets (Settings → Secrets) — copy name and value as-is:

- [ ] `SENTRY_TOKEN` — Devin reads the Sentry issue/stack trace
- [ ] `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE` (every `DD_*` secret HC-GTM has) — Devin queries the failure metrics/logs
- [ ] `SLACK_BOT_TOKEN` — Devin replies in the alert thread (the prompt tells it to `curl` Slack with this token)
- [ ] `COG_GTM_DEMO_SLACK_BOT_TOKEN` — used by the Production Alert automation / demo Slack app

Integrations and MCPs:

- [ ] **GitHub** — the integration must have write access to `COG-GTM/event-driven-devin` so Devin can push the fix branch and open the PR
- [ ] **Slack** — already installed; invite the Devin app and the alert bot to the demo alert channel
- [ ] **Datadog MCP** — present at org level; confirm it points at the same Datadog account as HC-GTM
- [ ] **Sentry MCP** — not installed; add it as HC-GTM has (or rely on `SENTRY_TOKEN` + API)

Automation:

- [ ] Recreate HC-GTM's **Production Alert** automation in HC-GTM-AD with the same trigger (alert card posted in the demo alert channel), prompt/playbook and repo (`COG-GTM/event-driven-devin`)
- [ ] If both orgs watch the same channel, make sure only one of them responds to the healthcare demos (otherwise each alert starts two sessions)

### Smoke test after setup

1. Open `/healthcare-lab` → Payer → **Submit for review**.
2. Within ~10 s: Slack card in the demo channel with a **View in Devin** link.
3. The session is in HC-GTM-AD, replies in the thread, and opens a PR against `COG-GTM/event-driven-devin`. **Do not merge it** if the demo must run again.

## Local check (no Slack, no Devin)

```bash
npm install
PORT=3999 node app/server.js          # leave SLACK_* / DEVIN_* unset
curl -s -X POST localhost:3999/api/ff0485e4/prior-auth -H 'Content-Type: application/json' \
  -d '{"memberId":"SHP-448210","cpt":"72148","placeOfService":"22"}'     # 500 TypeError
curl -s -X POST localhost:3999/api/3a2b7a6d/intake -H 'Content-Type: application/json' \
  -d '{"mrn":"MRN-100482","clinicianId":"LH-201","visitType":"telehealth"}'  # 500 TypeError
curl -s -X POST localhost:3999/api/46ce04a1/copay-benefit -H 'Content-Type: application/json' \
  -d '{"cardId":"VLX-5520-1187","productId":"VLR-90","insuranceOutOfPocket":1350}'  # 500 TypeError
curl -s -X POST localhost:3999/api/27a970ec/ingest -H 'Content-Type: application/json' \
  -d '{"siteId":"SITE-104"}'                                             # 500 TypeError
npx jest tests/healthcare-demo-lab.test.js
```

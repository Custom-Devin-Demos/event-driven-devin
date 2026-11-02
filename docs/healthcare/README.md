# Devin for Health — AD runbooks

Four healthcare demos built on the event-driven Devin loop. Each one is a realistic customer app with one hidden production bug. An AD clicks the main button, the app fails, and within seconds:

1. the error lands in **Sentry**,
2. failure metrics land in **Datadog**,
3. an **alert card** is posted in Slack,
4. a **Devin session** starts on its own, reads the alert, finds the bug and opens a **fix PR**.

Start at **`/healthcare-lab`** (the **Devin for Health** landing page, in Cognition branding) and pick a story. Each demo app has its own look: an enterprise payer portal, a warm patient portal, a consumer pharma savings site and a dark clinical-data console.

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
**What you see:** the *Decision path* on the right stops at **Clinical criteria** (red), and the Decision step shows “We couldn’t process this authorization request” with a reference number and error code `PRIOR_AUTH_FAILED`. The page never shows the raw exception; the `TypeError … 'requiredDocs'` only appears in Sentry and the Slack alert card.
**Show that it's only one path:** under *Place of service* click the **11 — Physician office** tile and **Submit for review** again — the Determination step turns green, *Approved*, with a PA reference number.

**What Devin does next:** the alert names `app/services/verticals/ff0485e4.js — submitPriorAuth` and tags `cpt=72148`, `placeOfService=22`. Devin opens that file and sees the place-of-service code 22 becomes `outpatient-hospital` (hyphen), but the clinical-criteria rule was saved as `72148:outpatient_hospital` (underscore), so no rule is found. It fixes the key, adds a test and opens a PR.

**Point at on screen:** the red **Clinical criteria** step in the Determination ladder (right column) and the *Clinical policy* table below it (the highlighted *Outpatient hospital* row is the one that should have gone to nurse review) → Slack alert card (service `ff0485e4-prior-auth-api`, CPT and place-of-service tags) → the Devin session thread → the one-line diff in the PR.

**Talk track (2 min):**
> “This is a health plan’s provider portal. A clinic wants approval for a back MRI at the hospital — one of the most common requests a payer gets. They press submit and… it breaks. In real life that request sits in limbo, the clinic calls provider services, and the patient’s scan slips a week.
> Nobody here filed a ticket. The moment that failed, the plan’s monitoring caught it and posted this alert in Slack — and Devin already picked it up. Watch the thread: it’s telling us which request broke and why. Turns out one rule was saved with a slightly different name than the system looks for, so hospital MRIs never matched. Office MRIs work fine, which is why nobody noticed.
> Here’s the pull request — a one-line fix, a test so it can’t come back, ready for the engineer to approve. For a payer with prior-auth turnaround rules, that’s minutes instead of a multi-day backlog.”

---

## 2. Provider — patient appointment intake (`/3a2b7a6d`)

**Trigger:** open `/3a2b7a6d` → leave the defaults (Jordan Rivera, Dr. Okafor, *Video visit*) → **Schedule appointment** in the “Your appointment” card.
**What you see:** “We couldn’t finish booking your appointment — your time was not reserved” with a reference number. The raw `TypeError … 'consents'` only appears in Sentry and the Slack alert card.
**Contrast:** click the *In person* tile under “How would you like to be seen?” — it books and lists the remaining check-in forms.

**What Devin does next:** the alert points to `app/services/verticals/3a2b7a6d.js — submitIntake` with tag `visitType=telehealth`. Devin finds the visit type is called `telehealth` but the intake forms list is filed under `virtual`, so there are no forms to send. It renames the key, adds a test and opens a PR.

**Point at on screen:** the selected *Video visit* tile, then the red “We couldn’t finish booking your appointment” panel that replaces the form (“your time was not reserved”, “engineering team has been notified”, the Reference id) → Slack alert card (`visitType: telehealth`) → Devin’s explanation in the thread → PR.

**Talk track (2 min):**
> “This is a hospital system’s patient portal. A patient is booking a video follow-up with their doctor — the kind of visit that’s become a huge share of primary care. They click confirm, and it fails. That patient either calls the front desk or just doesn’t book, and the health system loses the visit.
> The system didn’t wait for a complaint. The failure showed up in monitoring, posted here in Slack, and Devin started on it automatically. It’s found that video visits were renamed at some point, but the check-in paperwork was still filed under the old name — so every video booking breaks, while in-person visits keep working.
> Devin has already opened the fix. An engineer reviews and approves it; they didn’t have to dig through logs at 7 a.m. to find it.”

---

## 3. Pharma — copay savings card (`/46ce04a1`)

**Trigger:** open `/46ce04a1` → leave the defaults (card VLX-5520-1187, *Veloxa 90-day pack*, $1,350 out-of-pocket) → **Apply savings card**.
**What you see:** “Savings card could not be applied” on the patient receipt, patient owes the full $1,350, reject code `COPAY_BENEFIT_FAILED` and a reference. The raw `TypeError … 'cardMax'` only appears in Sentry and the Slack alert card.
**Contrast:** choose *Veloxa 30-day pen* under Product dispensed (the out-of-pocket changes to $450) — the receipt shows the card paying $425 and the patient paying $25.

**What Devin does next:** the alert points to `app/services/verticals/46ce04a1.js — calculateCopayBenefit` with `product=VLR-90` and the $1,350 amount. Devin sees the benefit tiers stop at $1,000, so the bigger 90-day amount matches no tier. It adds a top tier (or caps at the last one), adds a test and opens a PR.

**Point at on screen:** the *Patient receipt* panel: “Patient pays $1,350.00” with the card “could not be applied” → Slack card → Devin session → PR.

**Talk track (2 min):**
> “This is the savings card program for a specialty brand. The pharmacist is ringing up a 90-day supply, which the brand just started covering this year. They apply the card and it’s rejected. The patient is now being quoted over a thousand dollars at the counter — that’s exactly when patients walk away from therapy, and the brand loses the script.
> This alert came straight from production, and Devin is already working on it. Its finding: the program’s savings tiers were set up for 30-day amounts. The new 90-day pack costs more than the top tier, so the system has nothing to apply. 30-day fills work, which is why nobody caught it in testing.
> The fix is in a pull request waiting for review. For a patient-services team, that’s the difference between a weekend of abandoned prescriptions and fixing it before the next pharmacy calls.”

---

## 4. Life Sciences — clinical-trial lab data pipeline (`/27a970ec`)

**Trigger:** open `/27a970ec` → in the *Transfer inbox* leave *Toronto Research Centre (SITE-104)* selected → **Run ingest**.
**What you see:** the *Ingest run* stage list stops red at **Normalize units** and the result reads “Batch not loaded. Ingest stopped at normalize units” with error code `LAB_INGEST_FAILED` and a reference; the run log says the normalize stage failed and the batch rolled back. The raw `TypeError … 'factor'` only appears in Sentry and the Slack alert card.
**Contrast:** choose *Boston Clinical Unit (SITE-101)* in the inbox — all five stages turn green with timings, three records load into the study warehouse with range flags, and each row offers *Raise query*.

**What Devin does next:** the alert points to `app/services/verticals/27a970ec.js — ingestBatch` with `site=SITE-104`. Devin sees the Toronto lab reports glucose in mmol/L (the Canadian unit) and the pipeline only knows how to convert mg/dL. It adds the mmol/L conversion (×18.016), adds a test and opens a PR.

**Point at on screen:** the **Normalize units** stage turning red with its “Batch rolled back” note, the run log line `Batch rolled back. 0 rows written`, and the new *Audit trail* entry → Slack card (`site: SITE-104`) → Devin session → PR.

**Talk track (2 min):**
> “This is the data hub for a Phase III diabetes trial. Every day, lab results from each hospital site flow into the study database. The data manager runs today’s batch from the Toronto site and the whole batch fails. Those patients’ results don’t reach the study team — and with an interim data lock in eleven days, every day of missing data is a real problem.
> It went to Slack automatically, and Devin is already on it. What it found: the Canadian site reports blood sugar in a different unit than the US sites, and the pipeline only knew the US unit. US sites load fine, so this only showed up when Toronto came online.
> Devin added the conversion, wrote a test and opened the pull request. In a regulated environment the engineer still reviews and approves it — Devin just removed the hours of detective work.”

## 5. Thermo Fisher Scientific (PPD) — central lab data pipeline (`/bce3b3d2`)

Customer-branded copy of demo 4 for Thermo Fisher Scientific's PPD clinical research business. **Unlisted:** not on `/healthcare-lab`; share the direct URL `/thermofisher-central-lab` (also `/ppd-central-lab`, `/bce3b3d2`). The page uses the Thermo Fisher red logo block, the PPD wordmark and the ppd.com header, hero and palette; the sponsor (Helix Biopharma), study HLX-301, sites and subjects stay fictional and all data is synthetic.

**Reset:** same as the other four. The page keeps no state, so a reload brings back the failing Toronto batch. Keep Devin's fix PR unmerged if you want to run the demo again.

**Trigger:** open `/thermofisher-central-lab` → in the *Transfer inbox* leave *Toronto Research Centre (SITE-104)* selected → **Run ingest**. Like the other demos, the Devin session and the Slack @-mention follow the org and email picked on the devindemos.com homepage (`devinOrgId` / `devinUserId` / `devinEmail` in localStorage).
**What you see:** the same failure as demo 4. *Normalize units* turns red, and the result reads “Batch not loaded. Ingest stopped at normalize units” with code `LAB_INGEST_FAILED` and a reference. The raw `TypeError … 'factor'` shows up only in Sentry and the Slack card.
**Contrast:** choose *Boston Clinical Unit (SITE-101)*. All five stages turn green and three records load.

**What Devin does next:** the alert points to `app/services/verticals/bce3b3d2.js — ingestBatch` with `site=SITE-104` and customer `bce3b3d2`. Devin finds the missing glucose mmol/L entry in `UNIT_CONVERSIONS`, adds it (×18.016) with a test and opens a PR.

**Point at on screen:** the PPD central lab transfer file name (`PPDCL_HLX301_S104_…`), the red **Normalize units** stage, the run log line `Batch rolled back. 0 rows written` → Slack card in `#automated-alerts` → Devin session in HC-GTM-AD → PR.

**Talk track (2 min):**
> “This is a PPD central lab data hub for a Phase III diabetes trial. Every night, results from PPD’s central labs flow from each trial site into the study database. The data manager runs Toronto’s batch and the whole batch fails. Those patients’ results don’t reach the study team, and with an interim data lock in eleven days, every day of missing data is real risk to the sponsor’s timeline.
> Nobody filed a ticket. The failure went to Slack automatically and Devin is already working on it. What it found: the Canadian site reports blood glucose in mmol/L and the pipeline only knew the US unit, mg/dL. US sites load fine, so this only showed up when Toronto came online.
> Devin added the conversion, wrote a test and opened the pull request. In a GxP environment an engineer still reviews and approves the change. Devin took away the hours of detective work.”

**Host environment:** nothing demo-specific is required. Alerts go to the shared `SLACK_CHANNEL_ID` (`#automated-alerts`), the same channel as the other demos, and the session is created with the shared Devin service key in the org picked on the homepage. Set `DEVIN_SERVICE_KEY_BCE3B3D2` (an HC-GTM-AD service key) plus `DEVIN_ORG_ID_BCE3B3D2=org-ad5cb75ed086403697e4d37f8411936e` only if the shared key cannot create sessions in HC-GTM-AD; `SLACK_CHANNEL_ID_BCE3B3D2` and `DEVIN_USER_ID_BCE3B3D2` are optional overrides.

---

## 6. CVS Health (CVS Pharmacy) — copay savings card at pickup (`/1d54e3b4`)

Customer-branded copy of demo 3 for CVS Health. **Unlisted:** not on `/healthcare-lab`; share the direct URL `/cvs-copay` (also `/cvs-pharmacy-savings`, `/1d54e3b4`). The page uses the cvs.com pharmacy shell: CVS header and nav, CVS Health Sans, the navy pharmacy hero, the cvs.com footer and the CVS Health family bar. The pickup receipt is styled as a CVS register receipt. The manufacturer brand (Veloxa), cardholders, store and help-desk number are fictional and all data is synthetic.

**Reset:** reload the page. It keeps no state, so the failing 90-day fill comes back. Keep Devin's fix PR unmerged if you want to run the demo again.

**Trigger:** open `/cvs-copay` → leave the defaults (card VLX-5520-1187, *Veloxa 90-day pack*, $1,350 after insurance at CVS Pharmacy #10247) → **Apply savings card**. Like the other demos, the Devin session and the Slack @-mention follow the org and email picked on the devindemos.com homepage (`devinOrgId` / `devinUserId` / `devinEmail` in localStorage).
**What you see:** the receipt prints “SAVINGS CARD NOT APPLIED” and the patient owes the full $1,350.00; the message reads “Savings card could not be applied” with reject code `COPAY_BENEFIT_FAILED` and a reference. The raw `TypeError … 'cardMax'` shows up only in Sentry and the Slack card.
**Contrast:** choose *Veloxa 30-day pen* ($450 after insurance). The receipt shows the card paying $425.00 and the patient paying $25.00.

**What Devin does next:** the alert points to `app/services/verticals/1d54e3b4.js — calculateCopayBenefit` with `product=VLR-90`, the $1,350 amount and customer `1d54e3b4`. Devin sees `BENEFIT_TIERS` stop at $1,000, so the 90-day amount matches no tier. It adds a top tier (or caps at the last one), adds a test and opens a PR.

**Point at on screen:** the CVS receipt (“YOU PAY $1,350.00”, card not applied) → Slack card in `#automated-alerts` → Devin session in HC-GTM-AD → PR.

**Talk track (2 min):**
> “This is the pickup counter at a CVS Pharmacy. A patient on a weekly injectable is picking up a 90-day supply, which saves them two trips. The pharmacist applies the manufacturer's savings card and it's rejected, so the patient is quoted $1,350 instead of $25. That is the moment patients walk away from therapy, and a store loses the script.
> Nobody opened a ticket. The failure went to Slack on its own and Devin is already on it. What it found: the savings tiers were set up for 30-day amounts, and the 90-day out-of-pocket is bigger than the top tier, so there was nothing to apply. 30-day fills work, which is why testing missed it.
> The fix is in a pull request waiting for an engineer's review. Across thousands of stores, that's the difference between a weekend of abandoned prescriptions and a fix before the next patient reaches the counter.”

**Host environment:** nothing demo-specific is required. Alerts go to the shared `SLACK_CHANNEL_ID` (`#automated-alerts`) and the session is created with the shared Devin service key in the org picked on the homepage. Set `DEVIN_SERVICE_KEY_1D54E3B4` (an HC-GTM-AD service key) plus `DEVIN_ORG_ID_1D54E3B4=org-ad5cb75ed086403697e4d37f8411936e` only if the shared key cannot create sessions in HC-GTM-AD.

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

`<SLUG>` is each of `FF0485E4`, `3A2B7A6D`, `46CE04A1`, `27A970EC`, plus `BCE3B3D2` for the Thermo Fisher copy (all are `triggerMode: 'api'`). Placeholders are in `.env.example`.

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
  -d '{"memberId":"SHP-448210","cpt":"72148","placeOfService":"22"}'     # 500 (planted bug; TypeError in Sentry)
curl -s -X POST localhost:3999/api/3a2b7a6d/intake -H 'Content-Type: application/json' \
  -d '{"mrn":"MRN-100482","clinicianId":"LH-201","visitType":"telehealth"}'  # 500 (planted bug; TypeError in Sentry)
curl -s -X POST localhost:3999/api/46ce04a1/copay-benefit -H 'Content-Type: application/json' \
  -d '{"cardId":"VLX-5520-1187","productId":"VLR-90","insuranceOutOfPocket":1350}'  # 500 (planted bug; TypeError in Sentry)
curl -s -X POST localhost:3999/api/27a970ec/ingest -H 'Content-Type: application/json' \
  -d '{"siteId":"SITE-104"}'                                             # 500 (planted bug; TypeError in Sentry)
curl -s -X POST localhost:3999/api/bce3b3d2/ingest -H 'Content-Type: application/json' \
  -d '{"siteId":"SITE-104"}'                                             # 500 (Thermo Fisher copy of the same bug)
npx jest tests/healthcare-demo-lab.test.js
```

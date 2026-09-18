# Demo run sheet — Cigna Release Gate (Jira + ServiceNow)

Page: `/cigna` (alias of `/eac595f3`). No Slack anywhere in this flow.

## What it shows
A build is submitted for release → Devin checks the linked Jira story
(approval status, owner), test evidence (regression suite, coverage) and CAB
metadata (QA sign-off, rollback plan, change window, risk) → READY or BLOCKED.

- **BLOCKED**: exact gaps are commented on the Jira story, the story is pulled
  back to *In Progress* and assigned to the owning developer (Jira notifies
  them). No ServiceNow change is created. Optionally a Devin session is opened
  with the `cigna-release-gate` skill to clear the gaps.
- **READY**: a real ServiceNow `change_request` is created (Table API) with the
  evidence in the description/test plan/backout plan, a work note links the
  run, the CHG number is commented on the Jira story, and the build is handed
  to XL Release (mocked id `XLR-…`).

Every step lands in the on-page audit trail and on the Jira story.

## Setup
```bash
JIRA_EMAIL=… JIRA_API_TOKEN=… \
SERVICENOW_INSTANCE_URL=https://devXXXXX.service-now.com \
SERVICENOW_USER=… SERVICENOW_PASSWORD=… \
PORT=3100 node app/server.js
# open http://localhost:3100/cigna
```
Jira stories (COG-GTM, project MBA, label `cigna-release-gate`):
MBA-2552 claims-adjudication-svc · MBA-2553 member-portal-web ·
MBA-2554 pharmacy-benefits-api · MBA-2555 eligibility-batch.
Click **Reset demo** before you start — it clears local state and puts the
four stories back to their seed statuses (2553 In Progress, others Done).

## Seeded builds
| Build | Gap | Outcome |
|---|---|---|
| claims-adjudication-svc 4.12.0 | none | READY → CHG created |
| member-portal-web 7.3.1 | story not approved (In Progress) + no QA sign-off | BLOCKED, 2 gaps |
| pharmacy-benefits-api 2.8.0 | no rollback plan | BLOCKED, 1 gap |
| eligibility-batch 11.0.2 | 3 failing regression tests | BLOCKED, 1 gap |

## Arc (~5 min)
1. **Today's pain** (30s): read the four "What the gate replaces" steps —
   open Jira by hand, email the dev, wait, re-check, key the CHG manually.
2. **Blocked build** (90s): submit `member-portal-web 7.3.1`. Show the BLOCKED
   banner, the two failed checks with their *Fix:* lines, then open MBA-2553
   in Jira: the gate's comment, status back to In Progress, assignee set.
3. **Developer fixes the gap** (60s): click **Developer fixes gap** (adds the
   QA sign-off and moves the story to Done — stand-in for the dev doing the
   work), then **Resubmit**. READY → CHG number appears; click through to
   ServiceNow and to the READY comment on the story.
4. **Clean build straight through** (45s): submit `claims-adjudication-svc`.
   READY on the first pass, CHG + XL Release handoff, no human touch.
5. **Audit** (30s): scroll the audit trail — every submit, verdict,
   correction, Jira write and CHG is timestamped. Mention the optional Devin
   session (`triggerDevin`) that picks up blocked builds with the
   `cigna-release-gate` skill.

## API
```
GET  /api/eac595f3/builds
GET  /api/eac595f3/audit
POST /api/eac595f3/submit     { buildId, triggerDevin?, devinUserId?, devinOrgId? }
POST /api/eac595f3/remediate  { buildId }
POST /api/eac595f3/reset
```

---
name: cigna-release-gate
description: >
  Cigna Release Management — act on a build the release gate has BLOCKED.
  Use when a Devin session is created from the Cigna release-gate demo
  (/cigna, slug eac595f3) or when asked to clear a blocked release: close every
  missing requirement on the Jira story, fix failing evidence in code where
  needed, and get the build resubmitted. Never create the ServiceNow change
  yourself — only a clean resubmission through the gate does that.
---

# Cigna Release Gate — clear a BLOCKED build

## Overview
The release gate (`app/services/verticals/eac595f3.js`) runs when a build is
submitted at `POST /api/eac595f3/submit`. It reads each linked Jira story live
(COG-GTM Jira, project `MBA`, label `cigna-release-gate`), checks test evidence
and CAB metadata (QA sign-off, rollback plan, change window, risk), and returns
READY or BLOCKED. BLOCKED builds get a Jira comment listing the exact gaps and
the story is pulled back to *In Progress* and assigned to the owner. READY
builds create a ServiceNow `change_request` and are handed to XL Release
(mocked).

Your job in a BLOCKED session is the developer's half of the loop, without the
email round-trip.

## What's Needed From User
- The build id (e.g. `pharmacy-benefits-api@2.8.0`) or the gate comment text
- Jira access (`JIRA_EMAIL` / `JIRA_API_TOKEN` or the Atlassian MCP)

<phase name="Read the gap" id="1">
## Read the gap
1. Open the Jira story named in the prompt and read the latest
   "Release gate: BLOCKED" comment — it lists each failed check and its fix.
2. Pull the current manifest: `GET /api/eac595f3/builds` (or read `BUILDS` in
   the service) and confirm which checks still fail.
3. Classify each gap: **evidence/metadata** (QA sign-off, rollback plan, change
   window, risk, Jira approval) or **code/test** (failing regression tests,
   coverage).

<verification>
- Every failed check from the gate comment is listed with its category
- The owning developer (story assignee) is identified
</verification>
</phase>

<phase name="Close each gap" id="2">
## Close each gap
- Evidence/metadata: gather the artefact and record it on the Jira story as a
  comment (who signed off, rollback steps, window). Do not fabricate sign-offs —
  if none exists, comment on the story asking the assignee for it and stop.
- Jira approval: if product/QA approval is genuinely recorded in comments,
  transition the story to *Done*; otherwise leave it and note what is missing.
- Code/test: reproduce the failing suite in the service repo, fix the defect,
  run the suite, open a PR (never merge), link the PR on the story.
- In the demo app the developer's correction is `POST /api/eac595f3/remediate`
  with `{ "buildId": "<id>" }`; only call it when the underlying gap is real
  and closed.

<verification>
- Each gap has either a closing comment/artefact on the Jira story or an
  explicit "waiting on <person>" note
- Any code fix has a PR linked on the story and tests passing
</verification>
</phase>

<phase name="Resubmit and verify" id="3">
## Resubmit and verify
1. Resubmit: `POST /api/eac595f3/submit` with the build id (or click
   **Resubmit** on `/cigna`).
2. Confirm the verdict is READY, a `CHG` number is returned, and the story has
   the "Release gate: READY" comment with the ServiceNow link.
3. Frontend check: start the app (`PORT=3100 node app/server.js`), open
   `http://localhost:3100/cigna`, walk the queue → gate result → audit trail,
   and record a screen recording as proof the page still renders and the
   build shows READY with the CHG link.

<verification>
- Gate result is READY with a CHG number
- Jira story carries the READY comment linking the change
- Screen recording of the /cigna page captured
</verification>
</phase>

## Specifications
- ServiceNow changes are created only by the gate on a READY verdict.
- Every action is visible on the Jira story (audit requirement) — no Slack,
  no email side-channels.

## Forbidden Actions
- Do not call `servicenow.createChangeRequest` directly or create CHGs by hand.
- Do not transition a story to Done without recorded approval.
- Do not merge PRs.
- Do not edit `BUILDS` seed data to make a check pass.

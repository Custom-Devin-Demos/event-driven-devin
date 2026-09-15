---
name: qbench-prd-to-prod
description: QBench Workflow 1 — turn a ClickUp task ("Ready for Dev") into a reviewable PR via a dynamic workflow (plan -> 3 parallel implementations -> verifier -> PR). Use when a ClickUp-triggered automation session must implement a QBench LIMS story in this repo.
---

# QBench PRD -> production workflow

Stages (each a separate-VM child session, results recorded and resumable):

1. **plan** — spec -> acceptance criteria, files, test cases
2. **implement x3** — independent branches `devin/wf1-<task>-impl-N`, tests + lint must pass
3. **verify** — runs tests/lint on every branch, picks the smallest correct diff
4. **pull-request** — opens ONE PR from the winner against `main` (never merges)

Production = human review -> merge to `main` -> `.github/workflows/deploy.yml`.

## Run it

1. Write the spec (from ClickUp MCP `clickup_get_task`) to `/home/ubuntu/qbench_wf1_spec.json`:
   ```json
   {"task_id": "86bbz3u51", "task_url": "https://app.clickup.com/t/86bbz3u51",
    "title": "<task name>", "description": "<task description>"}
   ```
2. `run_workflow(workflow_name="qbench-prd-to-prod", script_path="<repo>/.devin/skills/qbench-prd-to-prod/workflow.py")`
3. Read `PLAN_JSON=`, `VERDICT_JSON=`, `PR_JSON=` lines from the run output and post them to ClickUp
   (plan comment after stage 1; PR link + verdict at the end, then move the task to **In Review**).
4. If the run is interrupted, re-run with the reported `run_id` to resume.

Costs ~6 child sessions per story; every stage sets a soft time limit.

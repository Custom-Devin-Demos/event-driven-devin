# Gusto Ticket Swarm — Run Sheet

**Total run time: ~6 minutes live, plus a swarm that runs in the background.** One story in three acts: a payroll batch fails, the customer's complaint becomes a parent ticket with sub-tickets, and Devin swarms the sub-tickets with one child session each and converges on a single PR.

**The story in one line:** Northstar Dental Group added its first Minnesota employees; their Sep 17 payroll will not release; support hears three different symptoms; Devin proves they are one bug and fixes it once.

The multi-agent shape is what the audience is here for. Make the hierarchy visible *before* any agent runs, then show the agents mirroring it.

---

## Before you walk in (5 minutes, do this early)

1. Open the console: **`https://<demo-host>/gusto`**.
2. Open Slack on `#oncall-alerts` and `#oncall-bugs` (whatever `SLACK_ONCALL_ALERTS_CHANNEL_ID` / `SLACK_ONCALL_BUGS_CHANNEL_ID` point at).
3. Open `.devin/skills/gusto-ticket-swarm/workflow.py` in an editor tab — you will edit a prompt in it live at 4:00.
4. **Run acts 1–3 once now** so a swarm is already in flight when you present. Investigators take a few minutes each; the fix stage longer. Do not watch it live — show the finished one, then kick off a fresh one the audience can watch start.
5. Do **not** merge any swarm PR. The MN defect is the demo.

---

## The 6 minutes

### 0:00 – 1:00 · Act 1: the batch fails

On `/gusto`, the on-call console shows batch **PB-2026-09-15-A**, 2,140 companies, pay date Thu Sep 17, ACH cutoff 17:30 PT.

Click **Release batch**. It fails. Point at `#oncall-alerts`: a monitor card lands — `TypeError`, employer contributions for MN cannot be computed, ACH debits blocked.

> "Note what did *not* happen: no agent started. Gusto's on-call flow keeps a human in the loop. The agents come in where the pain shows up — support."

### 1:00 – 2:00 · Act 2: one complaint, three symptoms, one parent ticket

Scroll to **Customer report**. The default text is Northstar Dental's complaint: three paragraphs — the batch won't release, MN employer contributions show $0.00, and four other companies are being held.

Point at the checkbox **File as parent ticket with sub-tickets** (on by default) and the preview: **1 parent ticket + 3 sub-tickets**.

Click **File ticket**. In `#oncall-bugs`:

- A parent card: `New support ticket GUS-1041 — Gusto Support`, listing `GUS-1041.1 / .2 / .3` and the line *"mention @Devin in this thread with `swarm this ticket`"*.
- Three threaded replies, one per symptom: `Sub-ticket GUS-1041.1 …`, each naming its parent.

> "This is how your support org already escalates: one case, several symptoms. We just kept the structure."

### 2:00 – 3:00 · Act 3: swarm

In the parent thread, type **`@Devin swarm this ticket`**.

Devin reacts :eyes:, replies "Swarming 3 sub-tickets — one child session each", and the workflow starts. Switch to the Devin app: the parent session, then three child sessions appear side by side, labelled `GUS-1041.1`, `.2`, `.3`.

> "One session per sub-ticket, each on its own machine, each reproducing its symptom against the repo. They don't talk to each other — a consolidator does that."

### 3:00 – 4:00 · The finished run (from your pre-run)

Open the parent thread from the earlier run. Show Devin's consolidated reply:

| sub-ticket | root cause | group |
|---|---|---|
| GUS-1041.1 | MN missing from `STATE_PAYROLL_PROGRAMS` | mn-programs |
| GUS-1041.2 | same | mn-programs |
| GUS-1041.3 | same (batch is all-or-nothing) | mn-programs |

Three symptoms, **one** root-cause group, **one** PR. Open the PR: MN added, validation before release, regression tests covering all three sub-tickets, a screen recording of `/gusto` releasing the batch and filing a ticket afterwards.

> "Three investigators, one fix. Nobody de-duplicated tickets by hand."

### 4:00 – 5:00 · Change the agents

Back in the editor tab, `workflow.py`, `investigate_stage`. Add a sentence to the prompt, e.g.:

```
Also query Datadog for gusto_payroll.batch_release latency on this batch and report it.
```

Save. In a *new* multi-symptom ticket's thread, `@Devin swarm this ticket` again. The new investigators pick up the change.

> "The agents are a file in your repo. Your on-call lead edits it; the next swarm behaves differently. No vendor ticket."

Other one-line edits that read well: change the grouping rule in `consolidate_stage`; require a rollback note in `fix_stage`; add a phase in `META`.

### 5:00 – 6:00 · Close

- Human stayed in the loop at both gates: the on-call alert, and the PR review.
- Fan-out matched the work: N sub-tickets → N investigators → 1 consolidator → 1 fixer.
- Guardrails are in the skill (`SKILL.md`): Gusto files only, never merge, never post outside the thread.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Ticket says "would have been filed" | Slack not configured | Set `SLACK_ONCALL_BOT_TOKEN` and `SLACK_ONCALL_BUGS_CHANNEL_ID`; restart |
| Parent card posts, sub-tickets don't thread | Bot lacks `chat:write` in the bugs channel or parent post returned no `ts` | Check the token's scopes; sub-tickets fall back to flat posts |
| Preview says "1 ticket" | Checkbox off or report has one paragraph | Blank lines separate symptoms; max 6 |
| Devin does not react to the mention | App not in `#oncall-bugs`, or the swarm skill not in the session's repo | Invite the app; confirm `.devin/skills/gusto-ticket-swarm/` on the branch the session clones |
| An investigator fails | Child hit a time limit | Workflow continues with an `unclear` finding; the report says so |

## Reference

- Frontend: `app/public/verticals/f8555891.html` · Service: `app/services/verticals/f8555891.js`
- Slack card builder: `postOncallBugReport` in `app/services/oncall.js` (`threadTs`, `ticketId`, `parentTicketId`)
- Swarm: `.devin/skills/gusto-ticket-swarm/{SKILL.md,workflow.py}`
- Tests: `tests/gusto-support-ticket.test.js`, `tests/oncall-bug-report-thread.test.js`, `tests/gusto-payroll-batch-release.test.js`

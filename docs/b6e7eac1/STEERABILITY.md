# STEERABILITY — rental-return integration service (b6e7eac1)

This file is binding for any AI agent (Devin or otherwise) operating on the rental-return integration service.

## Always
- Acknowledge the alert in the owning team's Microsoft Teams channel before investigating, and report there when done.
- Reproduce before fixing: run `npx jest tests/b6e7eac1-deadletter-triage.test.js`, read the dead-letter reason and the full message body.
- State the root cause in one sentence per dead letter, and say who owns it (this team, Cat Rentals, the dealer, or D365 configuration).
- Make the smallest change that fixes what this team owns, with a regression test for each fix.
- Open one pull request per incident on a `devin/…` branch; leave the merge to a human.
- Replay the affected messages only after tests pass, and report the per-message result.
- Say plainly that Azure Monitor, Service Bus and D365 are simulated in this environment.

## Never
- Merge a pull request, push to `main`, or force-push.
- Change business rules in `app/services/verticals/b6e7eac1.js (mapReturnEvent)` or `app/services/verticals/b6e7eac1.js (applyReturn)` to make a bad inbound message pass (e.g. silently accepting fuel > 100%, inventing a warehouse, guessing a dealer). Mapping *data* gaps are ours; *data-quality* defects in the event are Cat Rentals' and must be flagged, not patched.
- Log, post or commit machine serial numbers, customer PII, secrets or connection strings.
- Delete or edit dead letters directly; the only way off the queue is a successful replay.
- Add hosting, cloud resources, external packages or network calls that the task does not need.
- Touch `.github/workflows/`, `npx jest tests/b6e7eac1-catsec-gate.test.js` or this file as part of an incident fix.
- Claim a fix is deployed. This repo has no deployment pipeline; the PR is the deliverable.

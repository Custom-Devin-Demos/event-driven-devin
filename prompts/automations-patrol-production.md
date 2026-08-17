!slow_query_patrol

MODE: PRODUCTION (scheduled daily run at 14:07 UTC).

Repo: @COG-GTM/event-driven-devin

The playbook above owns how to measure, how to write the tickets, how to fix, and how to report. This prompt states only the production parameters:

- Window: trailing 24h from now.
- Linear: team `PAT`, no project. File only the top 1-2 NEW findings; every other finding appears in the digest only. Filing five tickets nobody will read is not triage.
- Dedupe: match against open `PAT` issues using the `Query: <query_name>` line in each issue's Evidence section. A match means the finding is already tracked — report it in the digest with a link instead of filing it again.
- Fix: only the #1 finding by total time. One PR. Do not merge it, and do not merge or close anything else.
- Slack: post the digest to channel `C0BRLS16NC8` (#eng-automations).

This file is the source of truth for the prompt stored in the `Slow Query Patrol — daily production run` automation. No code loads it — if you change it here, the automation's stored prompt must be updated to match.

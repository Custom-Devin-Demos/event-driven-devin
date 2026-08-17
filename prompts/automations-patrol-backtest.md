!slow_query_patrol

MODE: BACKTEST (triggered by the Run Now button on /automations).

Repo: @COG-GTM/event-driven-devin

The playbook above owns how to measure, how to write the tickets, how to fix, and how to report. This prompt states only what is different about a replay:

- Window: trailing 24h from now, same as the scheduled run.
- Linear: create a NEW project in team `PAT` named `patrol-backtest-<YYYY-MM-DD-HHMM>` in UTC, and file EVERY finding into that project — not just the top 1-2. Showing the whole ranking is the point of a replay.
- Dedupe: do NOT dedupe against production issues; a replay is meant to reproduce the full result. State on each issue, in one line: `Already tracked: backtest replay — production dedupe not applied`.
- Fix: still only the #1 finding, still one PR, still do not merge it.
- Slack: same digest format, with `(project: patrol-backtest-<...>)` appended after the filed links.
- Never modify, close, or comment on any production `PAT` issue outside the project you just created.

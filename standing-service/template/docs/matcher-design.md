# Matcher design

The matcher wakes every 60 seconds and selects every enabled recurring
trigger with `next_fire_at < window_end`. The query intentionally has **no
lower bound**: `next_fire_at` is a cursor, not a timestamp filter. If the
service is down for an hour, the next tick matches everything that came due
in that hour and coalesces it into a single run per trigger, then
`applyScheduleCursorUpdates()` advances the cursors past the window.

## Delivery semantics

Queue delivery is **at least once**. The ingest step must therefore be
idempotent: `automation_event_data` dedups on `(org_id, fingerprint)`, and
queue-row inserts plus cursor updates are committed in one transaction only
after every upload in the tick has succeeded. A tick that fails is redelivered
by the queue and re-processed from scratch.

## Event shapes

- Recurring ticks publish **one org-unscoped event** per window
  (`account_id: ''`, `org_ids: []`); ingest resolves the matched orgs itself.
- Manual runs publish an **org-scoped** event carrying that org's id.

This distinction matters when reading queue telemetry: a stuck recurring tick
affects every matched org at once, while a stuck manual run affects one.

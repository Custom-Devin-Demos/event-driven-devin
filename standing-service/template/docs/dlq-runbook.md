# DLQ runbook — automations queue

The automations queue delivers **at least once**: a message that fails
processing is redelivered up to `maxReceiveCount=8` (visibility timeout
120s) before landing in the DLQ. Anything in the DLQ failed eight
consecutive attempts and needs a human.

## When the DLQ alarm fires

1. Check `automation_service.ingest.tick_failed` for the failure rate.
2. Sample DLQ messages (`aws sqs receive-message` on the DLQ URL) and read the
   `Error processing SQS message` log lines for the matching stack traces.
3. If the failures come from a single org's payloads, disable that org's
   trigger in `automation_triggers` and notify the account team.
4. Purge the DLQ once the underlying cause is fixed. Do not re-drive DLQ
   messages back to the main queue in bulk: the matcher's `next_fire_at`
   cursor regenerates any missed recurring work on its next tick, so a
   redrive would double-run it.

## Retention

`automation_queued_events` accumulates completed rows over the instance's
lifetime. The pending index keeps hot scans fast, but prune periodically on a
long-lived host, e.g.:

```sql
DELETE FROM automation_queued_events
WHERE status = 'completed' AND terminal_at < now() - interval '30 days';
```

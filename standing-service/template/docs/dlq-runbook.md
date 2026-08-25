# DLQ runbook — automations queue

The automations queue delivers each matcher event **at most once**: a message
that fails processing is not retried by the service, so anything in the DLQ
represents work that was permanently skipped.

## When the DLQ alarm fires

1. Check `automation_service.ingest.tick_failed` for the failure rate.
2. Sample DLQ messages (`aws sqs receive-message` on the DLQ URL) and read the
   `Error processing SQS message` log lines for the matching stack traces.
3. If the failures come from a single org's payloads, disable that org's
   trigger in `automation_triggers` and notify the account team.
4. Purge the DLQ once the underlying cause is fixed. Because delivery is
   at-most-once, purged messages do not need to be replayed.

## Notes

- The DLQ redrive policy is `maxReceiveCount=8`, visibility timeout 120s.
- Do not re-drive DLQ messages back to the main queue in bulk; the matcher's
  cursor will regenerate current work on its next tick.

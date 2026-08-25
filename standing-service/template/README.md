# automations-service

Scheduled automations for the platform: a matcher that fires recurring
triggers, an ingest worker that stores each org's automation payloads in the
org's own cloud storage, and an executor that completes queued runs and
records them in the analytics warehouse.

## Architecture

```
matcher (60s cron) ──publish──▶ SQS ──receive──▶ ingest ──▶ org storage (provider A/B)
                                                   │
                                                   ▼
                                        automation_queued_events ──▶ executor ──▶ dim_sessions
```

- **Matcher** (`src/matcher.js`): selects due enabled triggers every minute
  and publishes one org-unscoped `schedule:recurring` event per tick. See
  `docs/matcher-design.md` for the cursor/coalescing semantics.
- **Ingest** (`src/ingest.js`): resolves matched orgs, uploads every org's
  payload via `IndirectData.newBlob(...)`, then commits queue rows and cursor
  advances in one transaction. A failed tick is redelivered by SQS and lands
  in the DLQ after 8 receives (`docs/dlq-runbook.md`).
- **Executor** (`src/executor.js`): drains pending queue rows, applies the
  per-org `automations-ingestion` flag at execution time, and writes a
  `dim_sessions` row to the warehouse per completed run.
- **Storage** (`src/storage/`): `storage_cloud_provider_configs` selects the
  provider client per org; both providers auto-create containers on first
  write.

## Running

```
cp .env.example .env   # fill in DATABASE_URL etc.
npm install
npm run migrate
npm start
```

Without `SQS_QUEUE_URL` the queue falls back to an in-memory implementation,
so the service and its tests run locally with no AWS access.

## Tests

```
npm test
```

## Ops endpoints

Internal admin API on `PORT` (bearer token in `ADMIN_TOKEN`):

- `POST /admin/demo/arm` / `POST /admin/demo/disarm` / `GET /admin/demo/status`
- `POST /admin/vpc/create` (requires `require_infra_manage`)

`scripts/provision-customer.js` provisions a customer's storage provider and
recurring trigger; `scripts/cherry-pick-to-release.sh` backports a mainline
commit to the current `release/*` branch.

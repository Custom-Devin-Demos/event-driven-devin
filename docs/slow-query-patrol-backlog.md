# Slow-query patrol backlog

These internal scheduler jobs intentionally exercise real fixture-data scans so
the scheduled Devin patrol can rank database work by aggregate daily impact.
They are not part of the customer-facing Acme Commerce surface.
The nginx proxy returns 404 for `/internal-jobs/...`; loadgen reaches these
routes directly through the container network, so before/after measurements
must target the checkout-api container rather than the public host.

| Job | Endpoint | Query name | Shape | Cadence |
| --- | --- | --- | --- | --- |
| Inventory report | `GET /internal-jobs/inventory-report` | `inventory.stock_by_sku` | N+1 stock-ledger scan for 120 SKUs | Every 2-minute deployed cycle |
| Order export | `GET /internal-jobs/order-export` | `orders.line_items_scan` | Nested order/line-item scan for 40 queries | Every third deployed cycle |
| Reconciliation | `GET /internal-jobs/reconciliation` | `ledger.full_scan` | Full-ledger scan repeated for 3 entries | Every 6th deployed cycle |

The inner-query telemetry contract is frozen as:

- `event: "db.query"`
- `query_name`
- `duration_ms`
- `rows_scanned`
- `job`
- `endpoint`

Each request also emits one `event: "internal_job.summary"` record with
`job`, `endpoint`, `total_duration_ms`, and `inner_query_count`.

The deployed compose default is a two-minute cycle, producing approximately
86,400 inventory events, 9,600 order-export events, and 360 reconciliation
events (120 job invocations) per day. Deployments can override the interval
through `LOADGEN_INTERVAL_MS`; at a five-minute override, those volumes are
approximately 34,560, 3,840, and 144 respectively (48 reconciliation
invocations). The patrol should rank by total duration per query name rather
than single-query duration. Keep `LOADGEN_INTERVAL_MS` at roughly 45000 ms or
higher with the default `INTERNAL_JOB_PER_IP_RATE_LIMIT=4`; shorter intervals
can silently drop internal-job telemetry when a prior cycle is still inside
the sliding window. If a faster cycle is necessary, raise both settings
together.

Internal-job failures are reported to Datadog only. They intentionally do not
enter the global Sentry error path because this application turns new Sentry
issues into Slack alerts and spawned Devin incident sessions.

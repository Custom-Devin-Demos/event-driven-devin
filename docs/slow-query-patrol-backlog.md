# Slow-query patrol backlog

These internal scheduler jobs intentionally exercise real fixture-data scans so
the scheduled Devin patrol can rank database work by aggregate daily impact.
They are not part of the customer-facing Acme Commerce surface.

| Job | Endpoint | Query name | Shape | Cadence |
| --- | --- | --- | --- | --- |
| Inventory report | `GET /internal-jobs/inventory-report` | `inventory.stock_by_sku` | N+1 stock-ledger scan for 120 SKUs | Every 5-minute cycle |
| Order export | `GET /internal-jobs/order-export` | `orders.line_items_scan` | Nested order/line-item scan for 40 queries | Every third cycle |
| Reconciliation | `GET /internal-jobs/reconciliation` | `ledger.full_scan` | Full-ledger scan repeated for 6 entries | Every 6th cycle |

The inner-query telemetry contract is frozen as:

- `event: "db.query"`
- `query_name`
- `duration_ms`
- `rows_scanned`
- `job`
- `endpoint`

Each request also emits one `event: "internal_job.summary"` record with
`job`, `endpoint`, `total_duration_ms`, and `inner_query_count`.

At the five-minute cadence used by the worker's schedule, the expected daily
inner-query volume is approximately 34,560 inventory events, 3,840 order-export
events, and 288 reconciliation events (48 job invocations). The patrol should
rank by total duration per query name rather than single-query duration.
Deployments can override the interval through `LOADGEN_INTERVAL_MS`; the
compose default is two minutes, which scales those event counts by 2.5.

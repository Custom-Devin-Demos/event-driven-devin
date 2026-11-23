# Billing estate migration (c0e5ab62)

Rehearsal of a billing database move from the data centre to the cloud. Both
sides are plain Postgres containers; all data is synthetic and deterministic.

| Piece | Where |
|-------|-------|
| Source (data centre) | `localhost:55432`, db/user/password `billing`, seeded from `sql/` |
| Target (cloud) | `localhost:55433`, db/user/password `billing`, tables created by the migration |
| Migration | `migrate.js` — copies `customers`, `accounts`, `invoices` in batches |
| Run summary | `reports/migration-run.json` — batch log and row counts read back from both sides |
| Validation report | `reports/validation-report.json` — written by whoever runs the comparison |
| Dashboard | `/c0e5ab62` in the app (`npm start`), reads both report files |

```bash
npm run c0e5ab62:up        # start both databases (source is seeded on first start)
npm run c0e5ab62:migrate   # copy source -> target, rewrite reports/migration-run.json
npm run c0e5ab62:down      # stop and delete both databases
```

Source timestamps are UK local time (`timestamp`, Europe/London). The target
stores instants (`timestamptz`).

## Validation report format

The dashboard shows whatever is in `reports/validation-report.json`. Append one
entry to `runs` per comparison run; the first run is the baseline and the
dashboard measures the time from it to the first run with zero differences.

```json
{
  "runs": [
    {
      "runAt": "2026-01-01T10:00:00.000Z",
      "totalDifferences": 0,
      "byTable": [
        { "table": "customers", "sourceRows": 0, "targetRows": 0, "differences": 0 }
      ],
      "causes": [
        {
          "id": "short-id",
          "title": "One line naming the cause",
          "differences": 0,
          "tables": [{ "table": "customers", "column": "full_name", "differences": 0 }],
          "script": { "file": "pipelines/c0e5ab62/migrate.js", "line": 0 },
          "sample": { "key": "customer_id=1", "source": "…", "target": "…" }
        }
      ]
    }
  ]
}
```

A difference is one row-level discrepancy of one kind: a row missing from the
target, an extra copy of a row, or a row whose value in one column differs.

# Standing automations-service (demo instance)

Everything needed to build, seed, and regenerate the standing
`automations-service` instance for the automations incident demo
(`docs/DEMO-AUTOMATIONS-INCIDENT.md` has the presenter run sheet; the control
plane lives in `app/routes/automations-demo.js`).

| Directory | Purpose | Ships to the standing repo? |
|-----------|---------|------------------------------|
| `template/` | The service source of truth: matcher, ingest, executor, storage providers, admin API, migrations, docs, tests | Yes — verbatim |
| `generator/` | Stamps a fresh repo with ~50 backdated commits whose HEAD tree equals `template/`, and optionally force-pushes it | No |
| `emitter/` | 24/7 load generator + PM2 process file for the droplet | No (deployed alongside, not committed to the standing repo) |
| `seed/` | Warehouse `dim_sessions` history seeder | No |

The generator/emitter/seed scaffolding stays out of the standing repo on
purpose: an incident session cloning that repo must find a plausible
production service, not the demo rigging.

## Investigation noise layers

The failure signal is deliberately not the only thing on the dashboards an
investigator has to weigh:

- CUST_2 is on provider B but never touches the poisoned subpath ("it's
  provider B" must be ruled out).
- CUST_14 has transient retried IndirectData writes (a second noisy tenant
  that is not the root cause).
- The emitter drips routine warnings from unrelated platform services (OAuth
  token refresh retries, slow warehouse queries).
- The stamped history lands a harmless matcher-logging commit at T-1d, so
  "did we ship anything yesterday?" has a plausible deploy to rule out.

## Regenerate the standing repo (quarterly, or whenever history looks stale)

```
node standing-service/generator/generate.js /tmp/automations-service \
  --push https://github.com/ananthv26-cog-demo-repos/automations-service.git
```

Commit dates are relative to the day you run it, so this is also how the
"flag removed 11 days ago" beat stays fresh.

## Run the template locally

```
cd standing-service/template
npm install && npm test
```

No AWS/Datadog/Postgres needed for tests: the queue falls back to in-memory
and the tests inject a DB stub.

## Deploy checklist (droplet)

1. Clone the stamped standing repo; `npm install`; fill `.env` from
   `.env.example` (`ADMIN_TOKEN` must equal the control plane's
   `AUTOMATIONS_DEMO_SERVICE_TOKEN`).
2. `npm run migrate`, then `node scripts/provision-customer.js` for each
   fixture in `emitter/fixtures.js` (CUST_1 and CUST_2 on `provider-b`).
3. Seed the warehouse: `node seed/seed-warehouse.js 7`.
4. `pm2 start emitter/ecosystem.config.js` (service + emitter).
5. Point a Datadog dead-man's-switch monitor at
   `automations.emitter.heartbeat`.

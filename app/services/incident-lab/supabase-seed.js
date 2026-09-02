const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const logger = require('../../telemetry/logger');

/**
 * Warehouse seed sink: replays a scenario's Supabase seed on every arm.
 *
 * The seed carries relative timestamps (the dead-lettered job sits at now−2h,
 * lining up with the backdated precursor burst), so a seed left over from a
 * previous run drifts out of the window the scenario points an investigator
 * at. Every scenario seed is idempotent — schema creation is `if not exists`
 * and every insert upserts — so re-running it at arm time is the cheapest way
 * to keep the warehouse consistent with the run about to start.
 *
 * Seeding never blocks a run: without a warehouse URL, or when the warehouse
 * is unreachable, the lab arms anyway and the presenter is told in the run log.
 */

const SEED_DIR = path.join(__dirname, '..', '..', '..', 'scripts', 'incident-lab');
const CONNECT_TIMEOUT_MS = 15000;

function warehouseUrl() {
  return process.env.INCIDENT_LAB_WAREHOUSE_URL || process.env.SUPABASE_WAREHOUSE_URL;
}

function seedPath(scenario) {
  const file = (scenario.warehouse && scenario.warehouse.seedFile) || null;
  if (!file) return null;
  // Scenario documents are authored in-repo, but the seed still resolves
  // under scripts/incident-lab so a scenario cannot name a path outside it.
  const resolved = path.resolve(SEED_DIR, file);
  if (path.dirname(resolved) !== SEED_DIR) return null;
  return resolved;
}

/** The seed file doubles as a psql script: everything past the transaction is
 *  presenter-facing verification written in psql meta-commands, which the
 *  wire protocol cannot run. Only the transaction body is replayed here. */
function executableSql(source) {
  const end = source.lastIndexOf('commit;');
  const body = end === -1 ? source : source.slice(0, end + 'commit;'.length);
  return body
    .split('\n')
    .filter((row) => !row.startsWith('\\'))
    .join('\n');
}

/** Sinks record presenter-facing progress on the run's own log, the same
 *  place the engine's lifecycle notes land and the control panel reads. */
function note(run, message) {
  run.log.push({ at: new Date().toISOString(), message });
}

function createSupabaseSeedSink({ deps = {} } = {}) {
  const api = {
    run: async (url, sql) => {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
      await client.connect();
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    },
    read: (file) => fs.readFileSync(file, 'utf8'),
    ...deps,
  };

  return {
    name: 'supabase-seed',
    async onArm(run) {
      const file = seedPath(run.scenario);
      if (!file) return;
      const url = warehouseUrl();
      if (!url) {
        note(run, 'warehouse seed skipped (no warehouse URL configured)');
        return;
      }
      try {
        await api.run(url, executableSql(api.read(file)));
        note(run, 'warehouse seed applied');
        logger.info('Incident Lab warehouse seed applied', {
          runRef: run.runRef,
          scenario: run.scenario.id,
        });
      } catch (error) {
        note(run, `warehouse seed failed: ${error.message}`);
        logger.warn('Incident Lab warehouse seed failed', {
          runRef: run.runRef,
          error: error.message,
        });
      }
    },
  };
}

module.exports = { createSupabaseSeedSink, executableSql };

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
// Arm is serialized with every other lifecycle action, so a warehouse that
// accepts the connection and then blocks the transaction on a lock would
// freeze the lab's controls. The seed is a few dozen small statements.
const STATEMENT_TIMEOUT_MS = 30000;

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
  const rows = source.split('\n');
  const end = rows.reduce((last, row, index) => (/^\s*commit\s*;/i.test(row) ? index : last), -1);
  return rows
    .slice(0, end === -1 ? rows.length : end + 1)
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
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        query_timeout: STATEMENT_TIMEOUT_MS,
      });
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

  async function seed(run) {
    const file = seedPath(run.scenario);
    if (!file) {
      run.warehouseSeeded = true;
      return;
    }
    const url = warehouseUrl();
    if (!url) {
      note(run, 'warehouse seed skipped (no warehouse URL configured)');
      run.warehouseSeeded = true;
      return;
    }
    try {
      await api.run(url, executableSql(api.read(file)));
      note(run, 'warehouse seed applied');
      run.warehouseSeeded = true;
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
  }

  return {
    name: 'supabase-seed',
    onArm: seed,
    // A restart can kill an arm mid-seed — the run is persisted before the
    // arm fan-out finishes — leaving the incident to declare against stale
    // warehouse rows. Seeding is idempotent, so an armed run that never
    // recorded a seed replays it; anything already declared is left alone.
    async onResume(run) {
      if (run.status !== 'armed' || run.warehouseSeeded) return;
      await seed(run);
    },
  };
}

module.exports = { createSupabaseSeedSink, executableSql };

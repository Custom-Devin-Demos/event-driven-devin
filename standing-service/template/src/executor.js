'use strict';

const { Pool } = require('pg');
const { getDb } = require('./db');
const { isIngestionEnabled } = require('./flags');
const { increment, log } = require('./telemetry');

// The executor drains pending queued events, emits the completion metric,
// and records each execution as a dim_sessions row in the analytics
// warehouse (WAREHOUSE_DATABASE_URL).

let warehousePool = null;
let injectedWarehouse = null;

function setWarehouse(stub) {
  injectedWarehouse = stub;
}

function warehouse() {
  if (injectedWarehouse) return injectedWarehouse;
  if (!process.env.WAREHOUSE_DATABASE_URL) return null;
  if (!warehousePool) {
    warehousePool = new Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL });
  }
  return warehousePool;
}

async function executeOne(row) {
  const db = getDb();

  // Per-org gating happens here, at execution time, for every source.
  if (!(await isIngestionEnabled(row.org_id))) {
    await db.query(
      `UPDATE automation_queued_events
       SET status = 'completed', terminal_at = now() WHERE id = $1`,
      [row.id],
    );
    increment('automation_service.execute.skipped_flag');
    return;
  }

  await db.query(
    `UPDATE automation_queued_events
     SET status = 'completed', terminal_at = now() WHERE id = $1`,
    [row.id],
  );
  increment('automation_service.execute.completed', { source: row.source });

  const wh = warehouse();
  if (wh) {
    try {
      await wh.query(
        `INSERT INTO dim_sessions (org_id, source, executed_at)
         VALUES ($1, $2, now())`,
        [row.org_id, row.source],
      );
    } catch (error) {
      log('error', 'Failed to write dim_sessions row', { error });
    }
  }
}

async function drainPending(limit = 500) {
  const db = getDb();
  const result = await db.query(
    `SELECT id, org_id, source FROM automation_queued_events
     WHERE status = 'pending' ORDER BY id LIMIT $1`,
    [limit],
  );
  for (const row of result.rows) {
    await executeOne(row);
  }
  return result.rows.length;
}

function start() {
  const loop = async () => {
    try {
      const started = Date.now();
      const drained = await drainPending();
      if (drained > 0) log('info', 'exec drain', { n: drained, ms: Date.now() - started });
      setTimeout(loop, drained > 0 ? 250 : 2000);
    } catch (error) {
      log('error', 'Executor loop error', { error });
      setTimeout(loop, 2000);
    }
  };
  loop();
}

module.exports = { drainPending, executeOne, setWarehouse, start };

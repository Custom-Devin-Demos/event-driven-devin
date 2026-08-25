'use strict';

require('dotenv').config();

// Seed >=7 days of dim_sessions history in the analytics warehouse
// (WAREHOUSE_DATABASE_URL) at rates matching the emitter fixtures, so the
// warehouse looks like it has always been receiving this traffic.
//
// Usage: node seed-warehouse.js [days]

const { Pool } = require('pg');
const { ENTERPRISES, longTailOrgs, SOURCE_BASELINES } = require('../emitter/fixtures');

const DAYS = Number(process.argv[2] || 7);
const BIN_MINUTES = 15;
const ALL_ORGS = [...ENTERPRISES, ...longTailOrgs()];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function main() {
  if (!process.env.WAREHOUSE_DATABASE_URL) {
    throw new Error('WAREHOUSE_DATABASE_URL is required');
  }
  const pool = new Pool({ connectionString: process.env.WAREHOUSE_DATABASE_URL });
  await pool.query(`CREATE TABLE IF NOT EXISTS dim_sessions (
    id BIGSERIAL PRIMARY KEY,
    org_id TEXT NOT NULL,
    source TEXT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const end = Date.now();
  const start = end - DAYS * 24 * 60 * 60 * 1000;
  let inserted = 0;
  const rows = [];

  for (let t = start; t < end; t += BIN_MINUTES * 60 * 1000) {
    for (const [source, baseline] of Object.entries(SOURCE_BASELINES)) {
      const count = Math.round(baseline.min + Math.random() * (baseline.max - baseline.min));
      for (let i = 0; i < count; i += 1) {
        const jitter = Math.random() * BIN_MINUTES * 60 * 1000;
        rows.push({ org: pick(ALL_ORGS).orgId, source, at: new Date(t + jitter).toISOString() });
      }
    }
    if (rows.length >= 5000) {
      inserted += await flush(pool, rows.splice(0));
    }
  }
  inserted += await flush(pool, rows);
  await pool.end();
  process.stdout.write(`seeded ${inserted} dim_sessions rows across ${DAYS} days\n`);
}

async function flush(pool, rows) {
  if (rows.length === 0) return 0;
  const values = [];
  const params = [];
  rows.forEach((row, i) => {
    values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
    params.push(row.org, row.source, row.at);
  });
  await pool.query(
    `INSERT INTO dim_sessions (org_id, source, executed_at) VALUES ${values.join(',')}`,
    params,
  );
  return rows.length;
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});

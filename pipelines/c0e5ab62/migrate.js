#!/usr/bin/env node
/**
 * Billing estate migration: copies customers, accounts and invoices from the
 * data-centre database to the cloud target, table by table, in batches.
 *
 *   node pipelines/c0e5ab62/migrate.js
 *
 * Writes reports/migration-run.json with the batch log and the row counts
 * read back from both databases once the load finishes.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SOURCE_URL = process.env.MIGRATION_SOURCE_URL || 'postgres://billing:billing@localhost:55432/billing';
const TARGET_URL = process.env.MIGRATION_TARGET_URL || 'postgres://billing:billing@localhost:55433/billing';
const REPORT_PATH = path.join(__dirname, 'reports', 'migration-run.json');

const BATCH_SIZE = 5000;
const CHUNK_SIZE = 500;
const SOURCE_CODEPAGE = 'latin1';

const fromSourceCodepage = (value) => Buffer.from(value).toString(SOURCE_CODEPAGE);
const normaliseMsisdn = (value) => value.replace(/\s+/g, '');

const TABLES = [
  {
    name: 'customers',
    key: 'customer_id',
    columns: [
      { name: 'customer_id', type: 'integer' },
      { name: 'full_name', type: 'varchar(80)', transform: fromSourceCodepage },
      { name: 'email', type: 'varchar(120)' },
      { name: 'address_line', type: 'varchar(40)' },
      { name: 'city', type: 'varchar(60)' },
      { name: 'postcode', type: 'varchar(10)' },
      { name: 'created_at', type: 'timestamptz' },
    ],
  },
  {
    name: 'accounts',
    key: 'account_id',
    columns: [
      { name: 'account_id', type: 'integer' },
      { name: 'customer_id', type: 'integer' },
      { name: 'account_type', type: 'varchar(12)' },
      { name: 'msisdn', type: 'varchar(15)', transform: normaliseMsisdn },
      { name: 'status', type: 'varchar(10)' },
      { name: 'opened_at', type: 'timestamptz' },
    ],
  },
  {
    name: 'invoices',
    key: 'invoice_id',
    windows: 2,
    columns: [
      { name: 'invoice_id', type: 'integer' },
      { name: 'account_id', type: 'integer' },
      { name: 'issued_at', type: 'timestamptz' },
      { name: 'due_date', type: 'date' },
      { name: 'net_amount', type: 'numeric(12,2)' },
      { name: 'vat_amount', type: 'numeric(12,2)' },
      { name: 'status', type: 'varchar(10)' },
    ],
  },
];

async function createTargetTable(target, table) {
  const ddl = table.columns.map((c) => `${c.name} ${c.type}`).join(', ');
  await target.query(`DROP TABLE IF EXISTS ${table.name}`);
  await target.query(`CREATE TABLE ${table.name} (${ddl})`);
}

async function readBatch(source, table, batch) {
  const select = table.columns.map((c) => `${c.name}::text`).join(', ');
  const { rows } = await source.query(
    `SELECT ${select} FROM ${table.name} ORDER BY ${table.name}.${table.key} LIMIT $1 OFFSET $2`,
    [BATCH_SIZE, batch * BATCH_SIZE],
  );
  return rows;
}

async function writeChunk(target, table, rows) {
  const values = [];
  const tuples = rows.map((row) => {
    const cells = table.columns.map((column) => {
      const raw = row[column.name];
      values.push(column.transform ? column.transform(raw) : raw);
      return `$${values.length}::${column.type}`;
    });
    return `(${cells.join(', ')})`;
  });
  const names = table.columns.map((c) => c.name).join(', ');
  await target.query(`INSERT INTO ${table.name} (${names}) VALUES ${tuples.join(', ')}`, values);
}

async function copyBatch(source, target, table, batch) {
  const rows = await readBatch(source, table, batch);
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + CHUNK_SIZE);
    await writeChunk(target, table, chunk);
    written += chunk.length;
  }
  return written;
}

async function migrateTable(source, target, table, log) {
  await createTargetTable(target, table);
  const total = Number((await source.query(`SELECT count(*) FROM ${table.name}`)).rows[0].count);
  const batches = Math.ceil(total / BATCH_SIZE);
  const windows = table.windows || 1;
  const perWindow = Math.ceil(batches / windows);
  const checkpoint = { lastBatch: -1 };

  for (let window = 0; window < windows; window += 1) {
    const first = window === 0 ? 0 : checkpoint.lastBatch;
    const last = Math.min(batches, (window + 1) * perWindow);
    for (let batch = first; batch < last; batch += 1) {
      try {
        const written = await copyBatch(source, target, table, batch);
        checkpoint.lastBatch = batch;
        log.push({ table: table.name, window, batch, status: 'ok', rows: written });
      } catch (error) {
        log.push({ table: table.name, window, batch, status: 'warning', message: error.message });
        console.warn(`[${table.name}] batch ${batch} warning: ${error.message}`);
      }
    }
  }
}

async function rowCounts(client) {
  const counts = {};
  for (const table of TABLES) {
    counts[table.name] = Number((await client.query(`SELECT count(*) FROM ${table.name}`)).rows[0].count);
  }
  return counts;
}

async function main() {
  const source = new Client({ connectionString: SOURCE_URL });
  const target = new Client({ connectionString: TARGET_URL });
  await source.connect();
  await target.connect();
  await target.query("SET TIME ZONE 'UTC'");

  const startedAt = new Date();
  const log = [];
  try {
    for (const table of TABLES) {
      await migrateTable(source, target, table, log);
      console.log(`[${table.name}] copied`);
    }
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'completed',
      batches: log.length,
      warnings: log.filter((entry) => entry.status === 'warning').length,
      rowCounts: { source: await rowCounts(source), target: await rowCounts(target) },
      log,
    };
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Migration ${report.status}: ${report.batches} batches, ${report.warnings} warning(s)`);
  } finally {
    await source.end();
    await target.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { TABLES, BATCH_SIZE, CHUNK_SIZE, main };

'use strict';

const { Pool } = require('pg');
const { log } = require('./telemetry');

let pool = null;
let injected = null;

// Tests inject a stub implementing { query(text, params) }.
function setDb(stub) {
  injected = stub;
}

function getDb() {
  if (injected) return injected;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on('connect', () => log('debug', 'pg pool conn open', { total: pool.totalCount, idle: pool.idleCount }));
    pool.on('remove', () => log('debug', 'pg pool conn closed', { total: pool.totalCount, idle: pool.idleCount }));
    pool.on('error', (error) => log('error', 'pg pool error', { error }));
  }
  return pool;
}

module.exports = { getDb, setDb };

'use strict';

const { Pool } = require('pg');

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
  }
  return pool;
}

module.exports = { getDb, setDb };

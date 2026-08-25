'use strict';

const { getDb } = require('./db');

// Feature flags backing scheduled automations.
//
// automations-ingestion: per-org publish gate consulted for org-scoped runs.
// Org-unscoped ticks (schedule:recurring) bypass it by design: they carry no
// org context at publish time, so per-org gating happens downstream at
// execution time.
//
// automations-kill-switch: global. When on, the matcher publishes nothing.

async function isIngestionEnabled(orgId) {
  const db = getDb();
  const result = await db.query(
    'SELECT enabled FROM feature_flags WHERE name = $1 AND org_id = $2',
    ['automations-ingestion', orgId],
  );
  if (result.rows.length === 0) return true;
  return result.rows[0].enabled;
}

async function isKillSwitchOn() {
  const db = getDb();
  const result = await db.query(
    "SELECT enabled FROM feature_flags WHERE name = 'automations-kill-switch' AND org_id IS NULL",
  );
  return result.rows.length > 0 && result.rows[0].enabled;
}

module.exports = { isIngestionEnabled, isKillSwitchOn };

'use strict';

const { getDb } = require('../src/db');
const queue = require('../src/queue');
const {
  stats,
  markArmed,
  markDisarmed,
  heartbeatAgeSeconds,
} = require('../src/runtime-stats');
const { log } = require('../src/telemetry');

// Internal ops endpoints used to enable/disable a customer's recurring
// automation and inspect live counters.

async function arm(req, res) {
  const customer = req.body?.customer;
  if (!customer || typeof customer !== 'string') {
    return res.status(400).json({ error: 'customer is required' });
  }
  const db = getDb();
  const result = await db.query(
    `UPDATE automation_triggers
     SET enabled = true, next_fire_at = now()
     WHERE org_id = $1 AND source = 'schedule:recurring'
     RETURNING next_fire_at`,
    [customer],
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: `No recurring automation for ${customer}` });
  }
  markArmed();
  log('info', 'Recurring automation enabled', { customer });
  return res.json({
    armed_at: stats.armedAt,
    next_fire_at: new Date(result.rows[0].next_fire_at).toISOString(),
  });
}

async function disarm(req, res) {
  const db = getDb();
  await db.query(
    `UPDATE automation_triggers SET enabled = false
     WHERE org_id = $1 AND source = 'schedule:recurring'`,
    ['CUST_1'],
  );
  let purged = 0;
  try {
    purged = await queue.purgeDlq();
  } catch (error) {
    log('error', 'DLQ purge failed during disarm', { error });
  }
  markDisarmed();
  return res.json({ disarmed_at: new Date().toISOString(), dlq_purged: purged });
}

async function status(req, res) {
  let depth = null;
  try {
    depth = await queue.dlqDepth();
  } catch (error) {
    log('error', 'Failed to read DLQ depth', { error });
  }
  return res.json({
    armed: Boolean(stats.armedAt),
    armed_at: stats.armedAt,
    errors_since_arm: stats.errorsSinceArm,
    dlq_depth: depth,
    emitter_heartbeat_age_s: heartbeatAgeSeconds(),
  });
}

module.exports = { arm, disarm, status };

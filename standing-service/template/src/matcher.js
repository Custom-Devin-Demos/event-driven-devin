'use strict';

const cron = require('node-cron');
const { getDb } = require('./db');
const { publish } = require('./queue');
const { isKillSwitchOn } = require('./flags');
const { increment, log } = require('./telemetry');

// The matcher runs every 60 seconds. It selects every enabled trigger whose
// next_fire_at falls before the end of the current window. There is
// deliberately no lower bound on the query: next_fire_at acts as a cursor,
// so triggers missed while the service was down are picked up on the next
// tick (coalesced into it) rather than skipped.

async function matchWindow(windowEnd = new Date()) {
  if (await isKillSwitchOn()) {
    increment('automation_service.matcher.skipped_kill_switch');
    return null;
  }
  const db = getDb();
  const result = await db.query(
    `SELECT id, org_id, source FROM automation_triggers
     WHERE enabled = true AND source = 'schedule:recurring' AND next_fire_at < $1`,
    [windowEnd.toISOString()],
  );
  if (result.rows.length === 0) return null;

  // Recurring schedule matches publish a single org-unscoped event per tick;
  // the ingest step resolves the matched orgs itself. Manual runs (see
  // publishManualRun) are org-scoped.
  const event = {
    type: 'schedule:recurring',
    account_id: '',
    org_ids: [],
    window_end: windowEnd.toISOString(),
    matched: result.rows.length,
  };
  await publish(event);
  increment('automation_service.matcher.published', { source: 'schedule' });
  log('info', 'Matcher published recurring tick', { matched: result.rows.length });
  return event;
}

async function publishManualRun(orgId, triggerId) {
  const event = {
    type: 'manual:run',
    account_id: orgId,
    org_ids: [orgId],
    trigger_id: triggerId,
  };
  await publish(event);
  increment('automation_service.matcher.published', { source: 'manual' });
  return event;
}

function start() {
  cron.schedule('* * * * *', () => {
    matchWindow().catch((error) => log('error', 'Matcher tick failed', { error }));
  });
}

module.exports = { matchWindow, publishManualRun, start };

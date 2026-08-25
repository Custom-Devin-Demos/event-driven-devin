'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');
const IndirectData = require('./indirect-data');
const { receive, MAX_RECEIVE_COUNT } = require('./queue');
const { increment, log } = require('./telemetry');
const { recordIngestFailure } = require('./runtime-stats');

// Ingest consumes matcher events. For a recurring (org-unscoped) tick it
// resolves every org with a due enabled trigger, uploads each org's payload
// to that org's own storage, then writes the queue rows and advances the
// schedule cursors in a single transaction.

async function resolveMatchedOrgs(db, event) {
  if (event.org_ids && event.org_ids.length > 0) return event.org_ids;
  const result = await db.query(
    `SELECT DISTINCT org_id FROM automation_triggers
     WHERE enabled = true AND source = 'schedule:recurring' AND next_fire_at < $1`,
    [event.window_end],
  );
  return result.rows.map((row) => row.org_id);
}

function buildPayload(orgId, event) {
  return {
    org_id: orgId,
    source: event.type,
    window_end: event.window_end || null,
    emitted_at: new Date().toISOString(),
  };
}

async function applyScheduleCursorUpdates(db, orgIds, windowEnd) {
  await db.query(
    `UPDATE automation_triggers
     SET next_fire_at = $2::timestamptz + (interval_s || ' seconds')::interval
     WHERE enabled = true AND source = 'schedule:recurring' AND org_id = ANY($1)`,
    [orgIds, windowEnd],
  );
}

async function processEvent(event) {
  const db = getDb();
  const orgIds = await resolveMatchedOrgs(db, event);
  if (orgIds.length === 0) return { uploaded: 0 };

  // All uploads for the tick run in one Promise.all.
  const session = { source: event.type };
  const uploads = await Promise.all(orgIds.map((orgId) => {
    const payload = buildPayload(orgId, event);
    return IndirectData.newBlob(session, orgId, 'automation_events', payload)
      .then((blob) => ({ orgId, blob, payload }));
  }));

  const windowEnd = event.window_end || new Date().toISOString();
  // Pin the transaction to one connection: pool.query() may hand each
  // statement a different pooled connection. Injected test stubs expose only
  // query(), so fall back to the stub itself.
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    try {
      for (const upload of uploads) {
        const fingerprint = crypto.createHash('sha256')
          .update(`${upload.orgId}:${windowEnd}:${event.type}`)
          .digest('hex');
        const inserted = await client.query(
          `INSERT INTO automation_event_data (org_id, fingerprint, subpath, blob_ref)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, fingerprint) DO NOTHING
           RETURNING id`,
          [upload.orgId, fingerprint, 'automation_events', upload.blob.ref],
        );
        // Fingerprint conflict means this window was already committed by an
        // earlier delivery of the same tick — don't re-enqueue the run.
        if (inserted.rows.length === 0) continue;
        await client.query(
          `INSERT INTO automation_queued_events (org_id, source, status)
           VALUES ($1, $2, 'pending')`,
          [upload.orgId, event.type],
        );
      }
      if (event.type === 'schedule:recurring') {
        await applyScheduleCursorUpdates(client, orgIds, windowEnd);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    if (typeof client.release === 'function') client.release();
  }
  increment('automation_service.ingest.uploaded', { source: event.type });
  return { uploaded: uploads.length };
}

async function consumeOnce() {
  const message = await receive();
  if (!message) return false;
  const event = JSON.parse(message.body);
  try {
    await processEvent(event);
    await message.ack();
  } catch (error) {
    increment('automation_service.ingest.tick_failed');
    recordIngestFailure();
    log('error', `Error processing SQS message ${message.receiveCount}/${MAX_RECEIVE_COUNT}, skipping`, { error });
    await message.nack();
  }
  return true;
}

function start() {
  const loop = async () => {
    try {
      const hadMessage = await consumeOnce();
      setTimeout(loop, hadMessage ? 50 : 1000);
    } catch (error) {
      log('error', 'Ingest loop error', { error });
      setTimeout(loop, 1000);
    }
  };
  loop();
}

module.exports = { processEvent, consumeOnce, start };

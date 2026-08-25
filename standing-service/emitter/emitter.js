'use strict';

require('dotenv').config();

// 24/7 load generator for the standing automations-service. Runs as a
// separate PM2 process on the same host. It:
//   - drives benign IndirectData traffic for every fixture org across the
//     non-poisoned subpaths (real storage writes through the service's own
//     storage layer);
//   - inserts completed automation runs at the per-source baseline rates so
//     the service's telemetry has a believable steady state;
//   - POSTs a heartbeat to the service (loopback) every 15s and emits the
//     automations.emitter.heartbeat metric, which the dead-man's-switch
//     monitor alerts on.
//
// It never arms/disarms anything: the poisoned CUST_1 recurring automation
// is controlled exclusively through the service's /admin/demo endpoints.

const path = require('path');
const StatsD = require('hot-shots');

const SERVICE_ROOT = process.env.SERVICE_ROOT || path.join(__dirname, '..', 'template');
/* eslint-disable import/no-dynamic-require */
const IndirectData = require(path.join(SERVICE_ROOT, 'src', 'indirect-data'));
const { getDb } = require(path.join(SERVICE_ROOT, 'src', 'db'));
/* eslint-enable import/no-dynamic-require */
const { ENTERPRISES, longTailOrgs, BENIGN_SUBPATHS, SOURCE_BASELINES } = require('./fixtures');

const statsd = new StatsD({
  host: process.env.DD_AGENT_HOST || '127.0.0.1',
  errorHandler: () => {},
  mock: !process.env.DD_AGENT_HOST,
});

const SERVICE_PORT = Number(process.env.PORT || 4000);
const ALL_ORGS = [...ENTERPRISES, ...longTailOrgs()];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function ratePerTick(baseline, tickSeconds) {
  const perBin = baseline.min + Math.random() * (baseline.max - baseline.min);
  return (perBin / 900) * tickSeconds;
}

async function benignTick() {
  // Weighted sample of orgs proportional to their benign rate.
  for (const org of ALL_ORGS) {
    if (Math.random() < (org.benignRatePerMin / 60) * 5) {
      const subpath = pick(BENIGN_SUBPATHS);
      try {
        await IndirectData.newBlob({ source: 'emitter' }, org.orgId, subpath, {
          org_id: org.orgId,
          kind: subpath,
          emitted_at: new Date().toISOString(),
        });
        statsd.increment('automations.emitter.benign_write', 1, { subpath });
      } catch (error) {
        statsd.increment('automations.emitter.benign_write_failed');
        process.stderr.write(`benign write failed for ${org.orgId}: ${error.message}\n`);
      }
    }
  }
}

async function completionTick(tickSeconds) {
  const db = getDb();
  for (const [source, baseline] of Object.entries(SOURCE_BASELINES)) {
    let n = ratePerTick(baseline, tickSeconds);
    while (n > 0) {
      if (n >= 1 || Math.random() < n) {
        const org = pick(ALL_ORGS);
        await db.query(
          `INSERT INTO automation_queued_events (org_id, source, status, terminal_at)
           VALUES ($1, $2, 'completed', now())`,
          [org.orgId, source],
        );
        statsd.increment('automation_service.execute.completed', 1, { source });
      }
      n -= 1;
    }
  }
}

async function heartbeat() {
  statsd.increment('automations.emitter.heartbeat');
  try {
    await fetch(`http://127.0.0.1:${SERVICE_PORT}/internal/heartbeat`, { method: 'POST' });
  } catch {
    // Service down: the metric still flows so the monitor sees the emitter alive.
  }
}

function start() {
  setInterval(() => { benignTick().catch(() => {}); }, 5000);
  setInterval(() => { completionTick(15).catch(() => {}); }, 15000);
  setInterval(() => { heartbeat().catch(() => {}); }, 15000);
  heartbeat().catch(() => {});
  process.stdout.write('emitter started\n');
}

if (require.main === module) start();

module.exports = { benignTick, completionTick, heartbeat, start };

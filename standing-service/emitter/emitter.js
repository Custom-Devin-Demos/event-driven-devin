'use strict';

require('dotenv').config();

// 24/7 load generator for the standing automations-service. Runs as a
// separate PM2 process on the same host. It:
//   - drives benign IndirectData traffic for every fixture org across the
//     non-poisoned subpaths (exercising the same storage code paths the
//     service uses, in this process);
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
const {
  ENTERPRISES, longTailOrgs, BENIGN_SUBPATHS, SOURCE_BASELINES, DECOY_SERVICES,
} = require('./fixtures');

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
  // Weighted sample of orgs proportional to their benign rate. Provider-B
  // orgs are skipped: the benign subpaths all carry underscores, which
  // provider B rejects, so their steady-state traffic is completion rows
  // only (see completionTick). This keeps CUST_2 genuinely healthy.
  for (const org of ALL_ORGS) {
    if (org.provider === 'provider-b') continue;
    if (Math.random() < (org.benignRatePerMin / 60) * 5) {
      const subpath = pick(BENIGN_SUBPATHS);
      // Orgs with a transientFailureRate time out first and succeed on the
      // retry — visible as retried-write warnings, never terminal failures.
      if (org.transientFailureRate && Math.random() < org.transientFailureRate) {
        statsd.increment('automation_service.indirect_data.write_retried', 1, { provider: org.provider });
        process.stderr.write(`${JSON.stringify({
          level: 'warn',
          message: 'IndirectData write timed out, retrying',
          timestamp: new Date().toISOString(),
          org_id: org.orgId,
          subpath,
          attempt: 1,
        })}\n`);
      }
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

// Routine warnings from neighboring platform services, so the automations
// failure signal is not the only non-green line on the shared dashboards.
function decoyTick() {
  if (Math.random() < 0.3) {
    const service = pick(DECOY_SERVICES);
    statsd.increment('platform.auth.token_refresh.retried', 1, { service });
    process.stderr.write(`${JSON.stringify({
      level: 'warn',
      message: 'OAuth token refresh retried after 401',
      timestamp: new Date().toISOString(),
      service,
      attempt: 1 + Math.floor(Math.random() * 2),
    })}\n`);
  }
  if (Math.random() < 0.2) {
    const durationMs = 3500 + Math.floor(Math.random() * 6000);
    statsd.histogram('warehouse.query.duration_ms', durationMs, { query: 'dim_sessions_rollup' });
    process.stderr.write(`${JSON.stringify({
      level: 'warn',
      message: 'Warehouse query exceeded slow threshold',
      timestamp: new Date().toISOString(),
      query: 'dim_sessions_rollup',
      duration_ms: durationMs,
    })}\n`);
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
  setInterval(decoyTick, 60000);
  heartbeat().catch(() => {});
  process.stdout.write('emitter started\n');
}

if (require.main === module) start();

module.exports = { benignTick, completionTick, decoyTick, heartbeat, start };

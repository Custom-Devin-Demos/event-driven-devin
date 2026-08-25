'use strict';

process.env.DD_AGENT_HOST = '';
process.env.SQS_QUEUE_URL = '';
process.env.SQS_DLQ_URL = '';
process.env.WAREHOUSE_DATABASE_URL = '';

const request = require('supertest');
const { setDb } = require('../src/db');
const queue = require('../src/queue');
const matcher = require('../src/matcher');
const ingest = require('../src/ingest');
const providerB = require('../src/storage/provider-b');
const { createAdminServer } = require('../admin/server');
const { markDisarmed, stats } = require('../src/runtime-stats');

// Minimal in-memory stand-in for the handful of queries the service issues.
function makeDb({ triggers = [], flags = [], providers = [] } = {}) {
  const state = { triggers, flags, providers, queuedEvents: [], eventData: [], vpc: [] };
  return {
    state,
    async query(text, params = []) {
      const sql = text.trim();
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT id, org_id, source FROM automation_triggers')) {
        const due = state.triggers.filter(
          (t) => t.enabled && t.source === 'schedule:recurring' && t.next_fire_at < params[0],
        );
        return { rows: due };
      }
      if (sql.startsWith('SELECT DISTINCT org_id FROM automation_triggers')) {
        const due = state.triggers.filter(
          (t) => t.enabled && t.source === 'schedule:recurring' && t.next_fire_at < params[0],
        );
        return { rows: [...new Set(due.map((t) => t.org_id))].map((org_id) => ({ org_id })) };
      }
      if (sql.startsWith('SELECT enabled FROM feature_flags WHERE name = $1')) {
        const flag = state.flags.find((f) => f.name === params[0] && f.org_id === params[1]);
        return { rows: flag ? [{ enabled: flag.enabled }] : [] };
      }
      if (sql.startsWith("SELECT enabled FROM feature_flags WHERE name = 'automations-kill-switch'")) {
        const flag = state.flags.find((f) => f.name === 'automations-kill-switch' && f.org_id == null);
        return { rows: flag ? [{ enabled: flag.enabled }] : [] };
      }
      if (sql.startsWith('SELECT provider, config FROM storage_cloud_provider_configs')) {
        const row = state.providers.find((p) => p.org_id === params[0]);
        return { rows: row ? [{ provider: row.provider, config: row.config || {} }] : [] };
      }
      if (sql.startsWith('INSERT INTO automation_event_data')) {
        const exists = state.eventData.some(
          (row) => row.org_id === params[0] && row.fingerprint === params[1],
        );
        if (exists) return { rows: [] };
        state.eventData.push({ org_id: params[0], fingerprint: params[1] });
        return { rows: [{ id: state.eventData.length }] };
      }
      if (sql.startsWith('INSERT INTO automation_queued_events')) {
        state.queuedEvents.push({ org_id: params[0], source: params[1], status: 'pending' });
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE automation_triggers\n     SET next_fire_at')
        || sql.includes('SET next_fire_at = $2::timestamptz')) {
        return { rows: [] };
      }
      if (sql.includes('SET enabled = true, next_fire_at = now()')) {
        const trigger = state.triggers.find(
          (t) => t.org_id === params[0] && t.source === 'schedule:recurring',
        );
        if (!trigger) return { rows: [] };
        trigger.enabled = true;
        trigger.next_fire_at = new Date().toISOString();
        return { rows: [{ next_fire_at: trigger.next_fire_at }] };
      }
      if (sql.includes('SET enabled = false')) {
        const trigger = state.triggers.find(
          (t) => t.org_id === params[0] && t.source === 'schedule:recurring',
        );
        if (trigger) trigger.enabled = false;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id FROM vpc_deployments')) {
        return { rows: state.vpc.filter((v) => v.org_id === params[0]) };
      }
      if (sql.startsWith('INSERT INTO vpc_deployments')) {
        const row = { id: state.vpc.length + 1, org_id: params[0], created_at: new Date().toISOString() };
        state.vpc.push(row);
        return { rows: [row] };
      }
      throw new Error(`Unhandled query in test db: ${sql.slice(0, 80)}`);
    },
  };
}

const PAST = new Date(Date.now() - 60000).toISOString();

beforeEach(() => {
  queue.resetLocal();
  markDisarmed();
  process.env.ADMIN_TOKEN = 'test-token';
});

test('matcher publishes one org-unscoped event per recurring tick', async () => {
  setDb(makeDb({
    triggers: [
      { id: 1, org_id: 'ORG_A', source: 'schedule:recurring', enabled: true, next_fire_at: PAST },
      { id: 2, org_id: 'ORG_B', source: 'schedule:recurring', enabled: true, next_fire_at: PAST },
    ],
  }));
  const event = await matcher.matchWindow(new Date());
  expect(event.account_id).toBe('');
  expect(event.org_ids).toEqual([]);
  expect(event.matched).toBe(2);
});

test('kill switch suppresses the tick', async () => {
  setDb(makeDb({
    triggers: [{ id: 1, org_id: 'ORG_A', source: 'schedule:recurring', enabled: true, next_fire_at: PAST }],
    flags: [{ name: 'automations-kill-switch', org_id: null, enabled: true }],
  }));
  expect(await matcher.matchWindow(new Date())).toBeNull();
});

test('provider-B rejects underscore container names client-side', async () => {
  const client = providerB.createClient({});
  await expect(client.uploadBlob('cust_1-automation_events', 'x.json', '{}'))
    .rejects.toMatchObject({ name: 'InvalidResourceName' });
  await expect(client.uploadBlob('cust-1-events', 'x.json', '{}')).resolves.toMatch(/^provider-b:/);
});

test('one poisoned org aborts the whole tick and the message lands in the DLQ after 8 receives', async () => {
  setDb(makeDb({
    triggers: [
      { id: 1, org_id: 'CUST_1', source: 'schedule:recurring', enabled: true, next_fire_at: PAST },
      { id: 2, org_id: 'ORG_B', source: 'schedule:recurring', enabled: true, next_fire_at: PAST },
    ],
    providers: [{ org_id: 'CUST_1', provider: 'provider-b' }],
  }));
  await matcher.matchWindow(new Date());
  const { stats: runtime } = require('../src/runtime-stats');
  require('../src/runtime-stats').markArmed();
  for (let i = 0; i < queue.MAX_RECEIVE_COUNT; i += 1) {
    await ingest.consumeOnce();
  }
  expect(runtime.errorsSinceArm).toBe(queue.MAX_RECEIVE_COUNT);
  expect(await queue.dlqDepth()).toBe(1);
  // Nothing was committed for the healthy org either: all-or-nothing tick.
});

test('admin contract: arm, status, disarm', async () => {
  const db = makeDb({
    triggers: [{ id: 1, org_id: 'CUST_1', source: 'schedule:recurring', enabled: false, next_fire_at: PAST }],
  });
  setDb(db);
  const app = createAdminServer();
  const auth = { Authorization: 'Bearer test-token' };

  await request(app).post('/admin/demo/arm').send({ customer: 'CUST_1' }).expect(403);

  const armed = await request(app).post('/admin/demo/arm').set(auth).send({ customer: 'CUST_1' }).expect(200);
  expect(armed.body.armed_at).toBeTruthy();
  expect(armed.body.next_fire_at).toBeTruthy();

  const status = await request(app).get('/admin/demo/status').set(auth).expect(200);
  expect(status.body.armed).toBe(true);
  expect(status.body.errors_since_arm).toBe(0);

  const disarmed = await request(app).post('/admin/demo/disarm').set(auth).expect(200);
  expect(disarmed.body.disarmed_at).toBeTruthy();
  expect(db.state.triggers[0].enabled).toBe(false);
  expect(stats.armedAt).toBeNull();
});

test('vpc create is capability-gated and 409s on the second deployment', async () => {
  setDb(makeDb());
  const app = createAdminServer();
  const auth = { Authorization: 'Bearer test-token' };
  await request(app).post('/admin/vpc/create').set(auth)
    .send({ customer: 'CUST_9' }).expect(403);
  await request(app).post('/admin/vpc/create').set(auth)
    .send({ customer: 'CUST_9', require_infra_manage: true }).expect(201);
  await request(app).post('/admin/vpc/create').set(auth)
    .send({ customer: 'CUST_9', require_infra_manage: true }).expect(409);
});

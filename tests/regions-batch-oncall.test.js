/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'batch-test', url: 'https://app.devin.ai/sessions/batch-test' }) }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn() }));
jest.mock('../app/services/datadog-incident-slack', () => ({ queueIncidentChannelInvites: jest.fn() }));
jest.mock('../app/services/oncall', () => {
  const actual = jest.requireActual('../app/services/oncall');
  return { ...actual, postOncallAlert: jest.fn(actual.postOncallAlert) };
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { createBatchSettlement } = require('../app/services/oncall-verticals/batchsettlement');
const createRouter = require('../app/routes/batchsettlement');
const { SLUG } = require('../config/regions-batch');
const { getOncallSkin } = require('../config/oncall-skins');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const logger = require('../app/telemetry/logger');
const presenter = { devinUserId: 'user_batch_presenter', devinOrgId: 'org_batch_presenter', devinEmail: 'presenter@example.com' };
const routingKeys = { BATCH_PD_ROUTING_KEY_MFT: 'a'.repeat(32), BATCH_PD_ROUTING_KEY_SQL: 'b'.repeat(32), BATCH_PD_ROUTING_KEY_MF: 'c'.repeat(32) };
const eventFor = (runId, service = 'PU8BL8X', type = 'incident.triggered') => ({ event: {
  event_type: type, data: { id: 'PINC123', type: 'incident', service: { id: service }, custom_details: { run_id: runId } },
} });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('batch settlement service', () => {
  let service, http, alert, env, clock;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clock = Date.parse('2026-11-16T01:00:00Z');
    env = { ...routingKeys, BATCH_PD_DRY_RUN: '1', BATCH_PD_API_TOKEN: 'test-only-token' };
    http = { get: jest.fn().mockResolvedValue({ data: { incidents: [], notes: [] } }), post: jest.fn().mockResolvedValue({ status: 202, data: { status: 'success' } }) };
    alert = jest.fn().mockResolvedValue({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/batch-test' });
    service = createBatchSettlement({ env, http, postAlert: alert, getSkin: getOncallSkin, now: () => clock });
  });
  afterEach(() => { service.reset(); jest.useRealTimers(); });
  const start = (service) => service.start({ skin: SLUG, ...presenter }).body.run_id;

  test('dry run logs only component names, sends nothing, and rejects a concurrent run', async () => {
    const id = start(service);
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(service.start({ skin: SLUG }).status).toBe(409);
    await jest.advanceTimersByTimeAsync(60000);
    expect(http.post).not.toHaveBeenCalled();
    expect(logger.info.mock.calls).toEqual([
      ['Batch settlement dry run', { component: 'MFT' }],
      ['Batch settlement dry run', { component: 'SQL' }],
      ['Batch settlement dry run', { component: 'MAINFRAME' }],
    ]);
    expect((await service.state()).run).toMatchObject({ run_id: id, status: 'complete', sent: ['MFT', 'SQL', 'MAINFRAME'] });
  });

  test('live dispatch preserves payloads, run correlation and 30s event ordering', async () => {
    env = { BATCH_PD_ROUTING_KEY_MFT: 'a'.repeat(32), BATCH_PD_ROUTING_KEY_SQL: 'b'.repeat(32), BATCH_PD_ROUTING_KEY_MF: 'c'.repeat(32) };
    service = createBatchSettlement({ env, http, now: () => clock });
    const id = start(service);
    await tick();
    expect(http.post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(29999);
    expect(http.post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(http.post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30000);
    expect(http.post.mock.calls.map(([, p]) => p.payload.component)).toEqual(['MFT', 'SQL', 'MAINFRAME']);
    for (const [url, payload] of http.post.mock.calls) {
      expect(url).toBe('https://events.pagerduty.com/v2/enqueue');
      expect(payload).toMatchObject({ event_action: 'trigger', dedup_key: `settlement-${id}-${payload.payload.component.toLowerCase()}`,
        payload: { severity: 'critical', custom_details: { run_id: id, evidence: 'logs/2026-11-15', profile: 'config/shared-tls-profile.json' } } });
    }
  });

  test('dispatch errors stop further events without logging credentials', async () => {
    env.BATCH_PD_DRY_RUN = '0';
    for (const key of ['MFT', 'SQL', 'MF']) env[`BATCH_PD_ROUTING_KEY_${key}`] = 'a'.repeat(32);
    http.post.mockRejectedValue(new Error('secret must not be logged'));
    service = createBatchSettlement({ env, http, now: () => clock });
    start(service);
    await jest.advanceTimersByTimeAsync(60000);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect((await service.state()).run.status).toBe('error');
    expect(logger.error).toHaveBeenCalledWith('Batch settlement event dispatch failed');
  });

  test('same run delivered twice or concurrently dispatches exactly once; distinct runs dispatch twice', async () => {
    const first = start(service);
    let finish;
    alert.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.webhook(eventFor(first));
    expect((await service.webhook(eventFor(first))).status).toBe(200);
    expect(alert).toHaveBeenCalledTimes(1);
    finish({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/first' });
    await pending;
    expect((await service.webhook(eventFor(first))).body.duplicate).toBe(true);
    await jest.advanceTimersByTimeAsync(60000);
    const second = start(service);
    await service.webhook(eventFor(second));
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls.map(([, o]) => o.runRef)).toEqual([first, second]);
    expect(alert).toHaveBeenLastCalledWith('batchsettlement', expect.objectContaining({
      ...presenter, destination: 'slack', runRef: second, unique: true,
      skin: expect.objectContaining({ slackChannelId: 'C0BNWUGCWBS',
        alertCard: expect.objectContaining({ endpointLabel: 'Triggered by PagerDuty: https://humza-cog.pagerduty.com/incidents/PINC123' }),
        devinSession: expect.objectContaining({
        auto: true, onCallIsTriggerer: true, repo: { name: 'COG-GTM/rg-oncall', branch: 'main' },
        promptAppendix: expect.stringContaining('Triggered by PagerDuty: https://humza-cog.pagerduty.com/incidents/PINC123'),
      }) }),
    }));
    expect((await service.state()).run.session_url).toContain('batch-test');
  });

  test('v3 incident data without alert details looks up the first REST alert', async () => {
    const id = start(service);
    http.get.mockResolvedValue({ data: { alerts: [{ body: { details: { run_id: id } } }] } });
    const body = eventFor(id);
    delete body.event.data.custom_details;
    expect((await service.webhook(body)).status).toBe(200);
    expect(http.get).toHaveBeenCalledWith('https://api.pagerduty.com/incidents/PINC123/alerts', expect.objectContaining({
      params: { limit: 1, offset: 0 }, headers: { Authorization: 'Token token=test-only-token', Accept: 'application/vnd.pagerduty+json;version=2' },
    }));
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test.each(['PU8BL8X', 'PCUSTOM'])('dispatch tells the session the configured MFT service %s', async (mftService) => {
    env.BATCH_PD_MFT_SERVICE_ID = mftService;
    service = createBatchSettlement({ env, http, postAlert: alert, getSkin: getOncallSkin, now: () => clock });
    const id = start(service);
    expect((await service.webhook(eventFor(id, mftService))).status).toBe(200);
    expect(alert.mock.calls[0][1].skin.devinSession.promptAppendix).toContain(`MFT service: ${mftService} (use this configured service ID instead of the default MFT service for this run).`);
  });

  test('failed lookup can be retried; missing alert run id is ignored', async () => {
    const id = start(service);
    const body = eventFor(id);
    delete body.event.data.custom_details;
    http.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { alerts: [] } })
      .mockResolvedValueOnce({ data: { alerts: [{ body: { details: { run_id: id } } }] } });
    await expect(service.webhook(body)).rejects.toThrow('offline');
    expect((await service.webhook(body)).status).toBe(202);
    expect((await service.webhook(body)).status).toBe(200);
  });

  test.each(['reject', 'no-session', 'skipped'])('failed dispatch releases reservation: %s', async (failure) => {
    const id = start(service);
    if (failure === 'reject') alert.mockRejectedValueOnce(new Error('offline'));
    else alert.mockResolvedValueOnce(failure === 'no-session' ? { ok: true } : { ok: false, skipped: true });
    expect((await service.webhook(eventFor(id))).status).toBe(503);
    expect((await service.webhook(eventFor(id))).status).toBe(200);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  test('non-MFT/non-triggered/unknown runs are ignored and reset invalidates old runs', async () => {
    const id = start(service);
    for (const body of [eventFor(id, 'PQZQKW7'), eventFor(id, 'PU8BL8X', 'incident.resolved'), eventFor('unknown'), {}]) {
      expect((await service.webhook(body)).status).toBe(202);
    }
    expect(http.get).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    service.reset();
    expect((await service.webhook(eventFor(id))).status).toBe(202);
    await jest.advanceTimersByTimeAsync(60000);
    expect((await service.state()).run).toBeNull();
  });

  test('state scope excludes resolved/old/boundary incidents, caches, and resets', async () => {
    const initial = clock;
    const item = (id, status, created_at) => ({ id, status, created_at: new Date(created_at).toISOString(), service: { id: 'PU8BL8X', summary: 'MFT' } });
    http.get.mockImplementation(async (url) => ({ data: url.endsWith('/notes')
      ? { notes: [{ id: 'n1', content: 'HOLD GL_POST', created_at: new Date(clock).toISOString() }] }
      : { incidents: [item('PNEW123', 'triggered', initial + 1000), item('POLD123', 'triggered', initial - 1),
        item('PEDGE12', 'acknowledged', initial), item('PDONE12', 'resolved', initial + 1000)] } }));
    clock += 2000;
    const state = await service.state();
    expect(state.jobs).toHaveLength(10);
    expect(state.incidents.map((i) => i.id)).toEqual(['PNEW123']);
    expect(state.incidents[0].notes[0].content).toBe('HOLD GL_POST');
    await service.state();
    expect(http.get).toHaveBeenCalledTimes(2);
    service.reset();
    expect((await service.state()).incidents).toEqual([]);
  });

  test('reset during an in-flight state fetch cannot repopulate stale cache', async () => {
    let finish;
    http.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.state();
    clock += 1000;
    service.reset();
    finish({ data: { incidents: [] } });
    expect((await pending).incidents).toEqual([]);
    http.get.mockResolvedValue({ data: { incidents: [] } });
    await service.state();
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test('missing REST token still returns inventory and an explicit warning', async () => {
    delete env.BATCH_PD_API_TOKEN;
    expect(await service.state()).toMatchObject({ incidents: [], run: null, warning: expect.stringContaining('token not configured') });
  });
});

describe('in-app PagerDuty simulation', () => {
  let service, http, alert;
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-16T01:00:00Z') });
    jest.clearAllMocks();
    http = { get: jest.fn(), post: jest.fn() };
    alert = jest.fn().mockResolvedValue({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/simulated', channel: 'C0BNWUGCWBS', ts: '1700000000.000100' });
    service = createBatchSettlement({ env: {}, http, postAlert: alert, getSkin: getOncallSkin });
  });
  afterEach(() => { service.reset(); jest.useRealTimers(); });

  test('three timed incidents, one direct dispatch per run, and a distinct session dispatch on the next run', async () => {
    expect(await service.state()).toMatchObject({ simulated: true, dry_run: false, incidents: [], activity: [], run: null });
    const first = service.start({ skin: SLUG, ...presenter });
    expect(first.body).toMatchObject({ simulated: true, dry_run: false });
    expect(service.start({ skin: SLUG }).status).toBe(409);
    await jest.advanceTimersByTimeAsync(0);
    expect((await service.state()).incidents).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(29999);
    expect((await service.state()).incidents).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect((await service.state()).incidents).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(30000);
    const state = await service.state();
    expect(state.run.status).toBe('complete');
    expect(state.incidents.map((i) => i.service.name)).toEqual(['Axway MFT Gateway', 'EDW SQL Load', 'Mainframe Batch zOS']);
    expect(state.incidents.map((i) => i.incident_number)).toEqual([1001, 1002, 1003]);
    expect(state.incidents.map((i) => i.created_at)).toEqual(['2026-11-16T01:00:00.000Z', '2026-11-16T01:00:30.000Z', '2026-11-16T01:01:00.000Z']);
    for (const i of state.incidents) {
      expect(i.id).toMatch(/^P[A-F0-9]{6}$/);
      expect(i).toMatchObject({ status: 'triggered', notes: [], custom_details: { run_id: first.body.run_id, evidence: 'logs/2026-11-15', profile: 'config/shared-tls-profile.json' } });
    }
    expect(state.activity).toEqual([expect.objectContaining({ content: 'Devin session started', session_url: 'https://app.devin.ai/sessions/simulated', slack_thread_url: 'https://app.slack.com/archives/C0BNWUGCWBS/p1700000000000100' })]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('batchsettlement', expect.objectContaining({ ...presenter, destination: 'slack', unique: true, runRef: first.body.run_id }));
    expect((await service.webhook(eventFor(first.body.run_id))).status).toBe(202);
    const second = service.start({ skin: SLUG, ...presenter });
    await jest.advanceTimersByTimeAsync(60000);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls.map(([, options]) => options.runRef)).toEqual([first.body.run_id, second.body.run_id]);
    expect((await service.state()).incidents.map((i) => i.incident_number)).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  test('inline prompt includes all incidents before SQL/mainframe arrive and forbids PagerDuty API/notes', async () => {
    service.start({ skin: SLUG, ...presenter });
    const prompt = alert.mock.calls[0][1].skin.devinSession.promptAppendix;
    expect(prompt).toContain('Do NOT call the PagerDuty API');
    expect(prompt).toContain('or post PagerDuty notes');
    expect(prompt).not.toContain('$PAGERDUTY_API_TOKEN');
    for (const number of [1001, 1002, 1003]) expect(prompt).toContain(`"incident_number": ${number}`);
    for (const name of ['Axway MFT Gateway', 'EDW SQL Load', 'Mainframe Batch zOS']) expect(prompt).toContain(name);
    for (const text of ['custom_details', 'created_at', 'run_id', 'HOLD table', 'rerun order', 'fix PR', 'rerun result', 'Awaiting human approval to merge and release holds']) expect(prompt).toContain(text);
    expect(prompt).toContain('THIS alert Slack thread, never a new top-level message');
    await jest.advanceTimersByTimeAsync(0);
    expect((await service.state()).incidents).toHaveLength(1);
  });

  test('reset clears incidents and session activity and cancels pending arrivals', async () => {
    service.start({ skin: SLUG });
    await jest.advanceTimersByTimeAsync(0);
    service.reset();
    await jest.advanceTimersByTimeAsync(60000);
    expect(await service.state()).toMatchObject({ incidents: [], activity: [], run: null });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('missing/invalid routing keys select simulation even with a REST token or legacy dry-run flag', async () => {
    service = createBatchSettlement({ env: { ...routingKeys, BATCH_PD_ROUTING_KEY_SQL: 'invalid', BATCH_PD_API_TOKEN: 'unused', BATCH_PD_DRY_RUN: '1' }, http, postAlert: alert, getSkin: getOncallSkin });
    service.start({ skin: SLUG });
    await jest.advanceTimersByTimeAsync(60000);
    expect(await service.state()).toMatchObject({ simulated: true, dry_run: false, incidents: expect.any(Array) });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  test('dispatch errors are visible without stopping incident arrivals or repeatedly starting sessions', async () => {
    alert.mockRejectedValue(new Error('unavailable'));
    service.start({ skin: SLUG });
    await jest.advanceTimersByTimeAsync(60000);
    expect(await service.state()).toMatchObject({ incidents: expect.any(Array), warning: 'Slack/Devin dispatch unavailable; start a new run to retry' });
    expect((await service.state()).incidents).toHaveLength(3);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe('batch settlement HTTP and native page', () => {
  let server, base, service, postAlert;
  const oldSecret = process.env.BATCH_PD_WEBHOOK_SECRET;
  beforeAll((done) => {
    postAlert = jest.fn().mockResolvedValue({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/http-test' });
    service = createBatchSettlement({ env: { ...routingKeys, BATCH_PD_DRY_RUN: '1' }, postAlert, getSkin: getOncallSkin });
    const app = express();
    app.use(express.json());
    app.use('/api/oncall/batchsettlement', createRouter(service, (_req, _res, next) => next()));
    app.use('/production', require('../app/routes/oncall'));
    app.use(require('../app/routes/oncall'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  beforeEach(() => { service.reset(); postAlert.mockClear(); process.env.BATCH_PD_WEBHOOK_SECRET = 'local-test-secret'; });
  afterAll(async () => {
    service.reset();
    if (oldSecret === undefined) delete process.env.BATCH_PD_WEBHOOK_SECRET;
    else process.env.BATCH_PD_WEBHOOK_SECRET = oldSecret;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await stopGateway();
  });
  const request = (suffix, body, secret = 'local-test-secret') => fetch(`${base}/api/oncall/batchsettlement/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret }, body: JSON.stringify(body),
  });

  test('webhook fails closed for missing configuration, missing header and incorrect secret', async () => {
    delete process.env.BATCH_PD_WEBHOOK_SECRET;
    expect((await request('pagerduty-webhook', {})).status).toBe(401);
    process.env.BATCH_PD_WEBHOOK_SECRET = 'local-test-secret';
    expect((await request('pagerduty-webhook', {}, '')).status).toBe(401);
    expect((await request('pagerduty-webhook', {}, 'wrong')).status).toBe(401);
    expect(postAlert).not.toHaveBeenCalled();
  });

  test('generic trigger rejects the webhook-only scenario without dispatching', async () => {
    postOncallAlert.mockClear();
    for (const body of [{ skin: SLUG }, {}]) {
      const response = await fetch(`${base}/api/oncall/trigger/batchsettlement`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(404);
    }
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('run 202/409, repeated signed webhook 200/200, reset clears only local state', async () => {
    const run = await request('runs', { skin: SLUG, ...presenter });
    expect(run.status).toBe(202);
    const { run_id } = await run.json();
    expect((await request('runs', { skin: SLUG })).status).toBe(409);
    expect((await request('pagerduty-webhook', eventFor(run_id))).status).toBe(200);
    expect((await request('pagerduty-webhook', eventFor(run_id))).status).toBe(200);
    expect(postAlert).toHaveBeenCalledTimes(1);
    expect((await request('reset', {})).status).toBe(200);
    expect((await request('pagerduty-webhook', eventFor(run_id))).status).toBe(202);
  });

  test('serves native skin, anonymous slug and friendly URL with no shim interception of Run', async () => {
    for (const route of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/regions-batch-oncall']) {
      const response = await fetch(base + route);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Regions — Enterprise Batch Control</title>');
      expect(html).toContain('Not a Regions Bank system — internal demo only.');
      expect(html).toContain('--accent:#356e20');
      expect(html).not.toContain('← All Demos');
      expect(html).toContain("action('/api/oncall/batchsettlement/runs')");
      expect(html).toContain('const apiPath = "/api/batchsettlement/unused"');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(script[1])).not.toThrow();
    }
    expect((await fetch(base + '/oncall/c/ffffffff')).status).toBe(404);
  });

  test('production run route enforces the same 50/hour IP cap as other triggers', async () => {
    for (let i = 0; i < 50; i += 1) {
      const response = await fetch(`${base}/production/api/oncall/batchsettlement/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skin: 'invalid' }),
      });
      expect(response.status).toBe(400);
    }
    const response = await fetch(`${base}/production/api/oncall/batchsettlement/runs`, { method: 'POST' });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

test('real native alert scopes the repository, honors presenter identity and threads the session link', async () => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'COTHER';
  const service = createBatchSettlement({ env: { ...routingKeys, BATCH_PD_DRY_RUN: '1' }, postAlert: postOncallAlert, getSkin: getOncallSkin });
  const { run_id } = service.start({ skin: SLUG, ...presenter }).body;
  let result;
  try { result = await service.webhook(eventFor(run_id)); }
  finally { service.reset(); }
  expect(result.body.sessionUrl).toContain('batch-test');
  expect(createDevinSession).toHaveBeenCalledWith(expect.stringContaining('*Slack Thread:* channel=C0BNWUGCWBS thread_ts=1700000000.000100'), expect.objectContaining({
    orgId: presenter.devinOrgId, userId: presenter.devinUserId, repos: ['COG-GTM/rg-oncall'],
  }));
  expect(createDevinSession.mock.calls[0][0]).toContain('Awaiting human approval to merge and release holds');
  expect(postMessage.mock.calls[0][1]).toBe('C0BNWUGCWBS');
  expect(JSON.stringify(postMessage.mock.calls[0])).toContain('https://humza-cog.pagerduty.com/incidents/PINC123');
  expect(postThreadReply.mock.calls[0].slice(1, 3)).toEqual(['C0BNWUGCWBS', '1700000000.000100']);
});

test('simulated native dispatch renders the exact PagerDuty Slack blocks and passes inline context to Devin', async () => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  const service = createBatchSettlement({ env: {}, postAlert: postOncallAlert, getSkin: getOncallSkin });
  try {
    const first = service.start({ skin: SLUG, ...presenter });
    await new Promise((resolve) => setImmediate(resolve));
    const state = await service.state();
    expect(state.run.session_url).toContain('batch-test');
    const incident = state.incidents[0];
    const blocks = postMessage.mock.calls[0][3];
    const incidentUrl = `https://devindemos.com/oncall/c/${SLUG}#incident-${incident.id}`;
    expect(blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', emoji: true, text: '[PagerDuty] Triggered #1001: Axway MFT Gateway — Inbound settlement file not received by SLA (TLS handshake failure)' } },
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Service:*\nAxway MFT Gateway' }, { type: 'mrkdwn', text: '*Urgency:*\nHigh' }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Escalation policy:*\nBatch and File Transfer Operations' }, { type: 'mrkdwn', text: '*Assigned to:*\non-call (<@U0BQZBHCNMA>)' }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: `*Incident:*\n<${incidentUrl}|#1001>` }] },
      { type: 'section', text: { type: 'mrkdwn', text: 'Repo: https://github.com/COG-GTM/rg-oncall/tree/main' } },
    ]);
    expect(JSON.stringify(blocks)).not.toMatch(/datadog/i);
    const prompt = createDevinSession.mock.calls[0][0];
    expect(prompt).toContain('Do NOT call the PagerDuty API');
    expect(prompt).not.toMatch(/datadog/i);
    expect(prompt).toContain(first.body.run_id);
    console.log('SIMULATED_PAGERDUTY_SLACK_BLOCKS ' + JSON.stringify(blocks));
  } finally { service.reset(); }
});

test.each([
  ['resolved presenter', 'UOTHER123', 'UOTHER123'],
  ['skin fallback', null, 'UFALLBACK77'],
])('PagerDuty card honors %s and the configured escalation policy', async (_name, resolvedMember, expectedMember) => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  lookupSlackUserByEmail.mockResolvedValueOnce(resolvedMember);
  const baseSkin = getOncallSkin(SLUG);
  const skin = { ...baseSkin, onCallSlackMemberId: 'UFALLBACK77', alertCard: { ...baseSkin.alertCard,
    pagerduty: { escalationPolicy: 'Regional Batch Operations' } } };
  const service = createBatchSettlement({ env: {}, postAlert: postOncallAlert, getSkin: () => skin });
  try {
    service.start({ skin: SLUG, ...presenter });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.state()).run.session_url).toContain('batch-test');
    const [, , text, blocks] = postMessage.mock.calls[0];
    const fields = blocks.flatMap((block) => block.fields || []).map((field) => field.text);
    expect(fields).toContain(`*Assigned to:*\non-call (<@${expectedMember}>)`);
    expect(fields).toContain('*Escalation policy:*\nRegional Batch Operations');
    expect(text).toContain(`*Assigned to:* on-call (<@${expectedMember}>)`);
    expect(text).toContain('*Escalation policy:* Regional Batch Operations');
    expect(JSON.stringify(blocks)).not.toContain('U0BQZBHCNMA');
  } finally { service.reset(); }
});

describe('ported tile rules', () => {
  let ui;
  beforeAll(() => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/db10f6b2.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1].split("$('fire').onclick")[0];
    ui = vm.createContext({});
    vm.runInContext(script, ui);
  });
  const incident = (content = '', service = 'PU8BL8X', status = 'triggered') => ({ status, service: { id: service },
    notes: content ? [{ content, created_at: '2026-11-16T02:00:00Z' }] : [] });
  test('normal and empty: failing jobs are red; untouched and acknowledged jobs stay scheduled', () => {
    expect(ui.jobState({ id: 'MFT_INBOUND' }, [])).toEqual(['scheduled', 'SCHEDULED']);
    for (const [id, service] of [['MFT_INBOUND', 'PU8BL8X'], ['SQL_STAGE', 'PQZQKW7'], ['EDW_LOAD', 'PQZQKW7'], ['SETTLE_POST', 'PN02JGH']]) {
      expect(ui.jobState({ id }, [incident('', service)])).toEqual(['failed', 'FAILED']);
    }
    expect(ui.jobState({ id: 'GL_POST' }, [incident()])[0]).toBe('scheduled');
    expect(ui.jobState({ id: 'MFT_INBOUND' }, [incident('', 'PU8BL8X', 'acknowledged')])[0]).toBe('scheduled');
  });
  test('HOLD/not resubmit override failure; PR adds a badge only; validation prose never greens tiles', () => {
    const items = [incident('HOLD MFT_INBOUND, GL_POST\nDo not resubmit REG_REPORT, STATEMENTS, TREASURY, FRAUD_REFRESH\nFix PR https://github.com/COG-GTM/rg-oncall/pull/2\nValidated MFT_INBOUND COMPLETE on fix branch')];
    for (const id of ['MFT_INBOUND', 'GL_POST', 'REG_REPORT', 'STATEMENTS', 'TREASURY', 'FRAUD_REFRESH']) expect(ui.jobState({ id }, items)[0]).toBe('hold');
    expect(ui.fixPRs(items)).toEqual(['https://github.com/COG-GTM/rg-oncall/pull/2']);
    expect(ui.jobState({ id: 'MFT_INBOUND' }, [incident('PR https://github.com/COG-GTM/rg-oncall/pull/2')])[0]).toBe('failed');
  });
  test('explicit per-job COMPLETE/RELEASED, multiline hold lists and latest directive win', () => {
    expect(ui.jobState({ id: 'GL_POST' }, [incident('HOLD:\n- GL_POST\n- TREASURY')])[0]).toBe('hold');
    expect(ui.jobState({ id: 'GL_POST' }, [incident('HOLD GL_POST\nGL_POST RELEASED')])[0]).toBe('ready');
    expect(ui.jobState({ id: 'GL_POST' }, [incident('COMPLETE GL_POST\nHOLD GL_POST')])[0]).toBe('hold');
    expect(ui.jobState({ id: 'GL_POST' }, [incident('COMPLETE GL_POST')])[0]).toBe('ready');
    expect(ui.jobState({ id: 'TREASURY' }, [incident('COMPLETE GL_POST')])[0]).toBe('scheduled');
  });
  test.each([';', ',', ' and'])('directives bind to adjacent jobs across %s clauses', (separator) => {
    const items = [incident(`GL_POST COMPLETE${separator} TREASURY remains on HOLD`)];
    expect(ui.jobState({ id: 'GL_POST' }, items)[0]).toBe('ready');
    expect(ui.jobState({ id: 'TREASURY' }, items)[0]).toBe('hold');
    expect(ui.jobState({ id: 'TREASURY' }, [incident('GL_POST COMPLETE; TREASURY remains scheduled')])[0]).toBe('scheduled');
  });
  test.each(['COMPLETE', 'RELEASED', 'HOLD', 'on HOLD'])('a trailing %s applies to comma/and job groups only', (instruction) => {
    const expected = instruction.endsWith('HOLD') ? 'hold' : 'ready';
    for (const separator of [', ', ' and ']) {
      const items = [incident(`GL_POST${separator}TREASURY ${instruction}`)];
      for (const id of ['GL_POST', 'TREASURY']) expect(ui.jobState({ id }, items)[0]).toBe(expected);
    }
    const group = [incident(`GL_POST, REG_REPORT and TREASURY ${instruction}; STATEMENTS remains scheduled`)];
    for (const id of ['GL_POST', 'REG_REPORT', 'TREASURY']) expect(ui.jobState({ id }, group)[0]).toBe(expected);
    expect(ui.jobState({ id: 'STATEMENTS' }, group)[0]).toBe('scheduled');
    expect(ui.jobState({ id: 'GL_POST' }, [incident(`GL_POST; TREASURY ${instruction}`)])[0]).toBe('scheduled');
  });
  test('job-owner bullets preserve the HOLD section until the next heading', () => {
    const items = [incident('HOLD:\n- TREASURY: Treasury Technology, SLA 04:00\n- GL_POST: Finance Technology, SLA 03:30\nRERUN ORDER:\n- REG_REPORT: Regulatory Technology')];
    for (const id of ['TREASURY', 'GL_POST']) expect(ui.jobState({ id }, items)[0]).toBe('hold');
    expect(ui.jobState({ id: 'REG_REPORT' }, items)[0]).toBe('scheduled');
  });
  test('live response note lists preserve failure and HOLD states with a Fix PR badge only', () => {
    const content = 'Root cause: shared TLS profile is incompatible with the post-patch gateway policy.\nHOLD MF_EXTRACT, GL_POST, REG_REPORT, STATEMENTS, TREASURY, FRAUD_REFRESH\nDo not resubmit SQL_STAGE, EDW_LOAD\nFix PR https://github.com/COG-GTM/rg-oncall/pull/2\nAwaiting human approval to merge and release holds';
    const items = [incident(content), incident('', 'PQZQKW7'), incident('', 'PN02JGH')];
    for (const id of ['MFT_INBOUND', 'SETTLE_POST']) expect(ui.jobState({ id }, items)[0]).toBe('failed');
    for (const id of ['SQL_STAGE', 'EDW_LOAD', 'MF_EXTRACT', 'GL_POST', 'REG_REPORT', 'STATEMENTS', 'TREASURY', 'FRAUD_REFRESH']) expect(ui.jobState({ id }, items)[0]).toBe('hold');
    expect(ui.fixPRs(items)).toEqual(['https://github.com/COG-GTM/rg-oncall/pull/2']);
  });
});

test('deployment accepts only the specified five secret formats and stages all five Actions secrets', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/deploy-ec2.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  const functions = script.slice(script.indexOf('ENV_SYNC_KEYS=('), script.indexOf('if [ -n "${ENV_SYNC_FILE:-}"'));
  for (const [key, good, bad] of [
    ['BATCH_PD_ROUTING_KEY_MFT', 'a'.repeat(32), ['a'.repeat(31), 'a'.repeat(33), '_'.repeat(32)]],
    ['BATCH_PD_ROUTING_KEY_SQL', 'B'.repeat(32), ['B'.repeat(31)]],
    ['BATCH_PD_ROUTING_KEY_MF', '1'.repeat(32), ['1'.repeat(33)]],
    ['BATCH_PD_API_TOKEN', 'aB01_+-'.repeat(4), ['a'.repeat(19), 'a'.repeat(65), 'a'.repeat(20) + '!']],
    ['BATCH_PD_WEBHOOK_SECRET', 'aB01_-'.repeat(4), ['a'.repeat(15), 'a'.repeat(129), 'a'.repeat(20) + '+']],
  ]) {
    expect(workflow).toContain(`${key}: \u0024{{ secrets.${key} }}`);
    const check = (value) => spawnSync('bash', ['-c', `${functions}\nis_env_sync_key "$TEST_KEY" && env_sync_value_ok "$TEST_KEY" "$TEST_VALUE"`], {
      env: { ...process.env, TEST_KEY: key, TEST_VALUE: value },
    }).status;
    expect(check(good)).toBe(0);
    for (const value of [...bad, '', good + '\nINJECT=1', good + ';']) expect(check(value)).not.toBe(0);
  }
});

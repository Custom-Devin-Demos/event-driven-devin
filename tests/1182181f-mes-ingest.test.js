/* global describe, expect, test, beforeEach, afterAll, jest */

jest.mock('../app/telemetry/datadog', () => ({
  tracer: { init: jest.fn() },
  initDatadog: jest.fn(),
  getStatsClient: jest.fn(() => null),
  recordMetric: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({})),
}));

const express = require('express');
const http = require('http');
const service = require('../app/services/verticals/1182181f');
const { LINE_MANIFESTS } = require('../app/services/verticals/1182181f-line-manifests');
const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const route = require('../app/routes/verticals/1182181f');

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(responseBody) })));
      });
      req.on('error', (error) => server.close(() => reject(error)));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function testApp() {
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

beforeEach(() => {
  service.resetStore(Date.now());
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

afterAll(() => service.stopScheduler());

describe('1182181f historian → MES ingest', () => {
  test('seeds four lines with L4 stale and repeated decode failures', () => {
    const plant = service.getPlant();
    expect(plant.plant).toMatchObject({ code: 'P07', company: 'Talon Power Systems' });
    expect(plant.lines.map((line) => line.code)).toEqual(['L1', 'L2', 'L3', 'L4']);
    const l4 = plant.lines.find((line) => line.code === 'L4');
    expect(l4.stale).toBe(true);
    expect(l4.protocol).toBe('opcua');
    expect(l4.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(plant.lines.filter((line) => line.code !== 'L4').every((line) => !line.stale)).toBe(true);
    const latest = service.listRuns({ lineCode: 'L4', limit: 1 })[0];
    expect(latest).toMatchObject({ status: 'failed', stageReached: 'decode' });
    expect(latest.error.message).toBe("Cannot read properties of undefined (reading 'decode')");
    expect(plant.summary.failedRunsLast24h).toBeGreaterThan(0);
  });

  test('runs MTConnect and OPC DA lines through publish', async () => {
    for (const code of ['L1', 'L2', 'L3']) {
      const run = await service.runPipeline(code, { trigger: 'manual' });
      expect(run).toMatchObject({ status: 'succeeded', stageReached: 'publish', lineCode: code });
      expect(run.rowsIn).toBeGreaterThan(0);
      expect(run.rowsOut).toBeGreaterThan(0);
      expect(run.rowsOut).toBeLessThanOrEqual(run.rowsIn);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    const line = service.getLine('L1');
    expect(line.cells.length).toBeGreaterThan(0);
    expect(line.cells[0]).toEqual(expect.objectContaining({
      state: expect.any(String),
      goodCount: expect.any(Number),
    }));
  });

  test('L4 fails at decode because no opcua-statuscode decoder is registered', async () => {
    const run = await service.runPipeline('L4', {
      trigger: 'manual',
      devinUserId: 'user-from-hub',
      devinOrgId: 'org-from-hub',
      devinEmail: 'operator@example.com',
    });
    expect(run).toMatchObject({ status: 'failed', stageReached: 'decode' });
    expect(run.error).toMatchObject({ name: 'TypeError', stage: 'decode' });
    expect(run.error.message).toBe("Cannot read properties of undefined (reading 'decode')");
    expect(LINE_MANIFESTS.L4.quality.encoding).toBe('opcua-statuscode');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toEqual(expect.objectContaining({
      line: 'L4', stage: 'decode', alert_path: 'instant',
    }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toEqual(expect.objectContaining({
      customer: '1182181f',
      errorType: 'TypeError',
      devinUserId: 'user-from-hub',
      devinOrgId: 'org-from-hub',
      devinEmail: 'operator@example.com',
    }));
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('slackMemberId');
  });

  test('throttles scheduled alerts but always alerts manual runs', async () => {
    await service.runPipeline('L4', { trigger: 'scheduled' });
    await service.runPipeline('L4', { trigger: 'scheduled' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    await service.runPipeline('L4', { trigger: 'manual' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('acknowledges alarms', () => {
    const open = service.ALARMS.find((alarm) => alarm.state === 'ACTIVE_UNACK');
    expect(open).toBeTruthy();
    const acked = service.acknowledgeAlarm(open.id, 'jdoe');
    expect(acked.state).toBe('ACTIVE_ACK');
    expect(acked.ackBy).toBe('jdoe');
    expect(service.acknowledgeAlarm('ALM-nope', 'jdoe')).toBeNull();
  });

  test('serves plant, line, run and ack routes with validation', async () => {
    const app = testApp();
    const plant = await request(app, 'GET', '/api/1182181f/plant');
    expect(plant.status).toBe(200);
    expect(plant.body.lines).toHaveLength(4);
    const line = await request(app, 'GET', '/api/1182181f/lines/L2');
    expect(line.status).toBe(200);
    expect(line.body.line.code).toBe('L2');
    expect((await request(app, 'GET', '/api/1182181f/lines/L9')).status).toBe(404);
    const healthy = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'L1' });
    expect(healthy.status).toBe(200);
    expect(healthy.body.runs[0].status).toBe('succeeded');
    const failing = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'L4', devinOrgId: 'org-x' });
    expect(failing.status).toBe(200);
    expect(failing.body.runs[0]).toMatchObject({ status: 'failed', stageReached: 'decode' });
    expect(createSessionAndAlert.mock.calls.at(-1)[0].devinOrgId).toBe('org-x');
    expect((await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'NOPE' })).status).toBe(400);
    const runs = await request(app, 'GET', '/api/1182181f/runs?limit=5');
    expect(runs.body.runs.length).toBeLessThanOrEqual(5);
    const alarm = service.ALARMS.find((candidate) => candidate.state === 'ACTIVE_UNACK');
    const ack = await request(app, 'POST', `/api/1182181f/alarms/${alarm.id}/ack`, { user: 'jdoe' });
    expect(ack.status).toBe(200);
    expect(ack.body.alarm.state).toBe('ACTIVE_ACK');
    expect((await request(app, 'POST', '/api/1182181f/alarms/ALM-0/ack', {})).status).toBe(404);
  });
});

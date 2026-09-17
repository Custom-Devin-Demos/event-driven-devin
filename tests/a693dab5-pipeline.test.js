/* global describe, expect, test, beforeEach, afterAll, jest */

jest.mock('../app/telemetry/datadog', () => ({
  tracer: { init: jest.fn() },
  initDatadog: jest.fn(),
  getStatsClient: jest.fn(() => null),
  recordMetric: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({})),
}));

const express = require('express');
const http = require('http');
const service = require('../app/services/verticals/a693dab5');
const { createSessionAndAlert } = require('../app/services/devin-session');
const route = require('../app/routes/verticals/a693dab5');

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const address = server.address();
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(responseBody) }));
        });
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
});

afterAll(() => service.stopScheduler());

describe('a693dab5 fleet health pipeline', () => {
  test('seeds stale MPX engines and failed normalize runs', () => {
    const fleet = service.getFleet();
    const mpx = fleet.operators.find((operator) => operator.code === 'MPX');
    expect(mpx.consecutiveFailures).toBe(3);
    expect(fleet.engines.filter((engine) => engine.operatorCode === 'MPX').every((engine) => engine.stale)).toBe(true);
    expect(fleet.engines.filter((engine) => engine.operatorCode !== 'MPX').every((engine) => !engine.stale)).toBe(true);
    expect(fleet.engines.every((engine) => engine.egtMarginHistory.length === 12)).toBe(true);
    expect(fleet.engines.every((engine) => engine.egtMarginC === engine.egtMarginHistory.at(-1))).toBe(true);
    expect(fleet.engines[0]).toEqual(expect.objectContaining({
      operatorName: expect.any(String),
      aircraftType: expect.any(String),
      position: expect.any(Number),
      egtMarginHistory: expect.any(Array),
    }));
    expect(fleet.openExceedances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'EXC-1041', metric: 'egtMarginC', level: 'CAUTION' }),
    ]));
    const latestMpx = service.listRuns({ operatorCode: 'MPX', limit: 1 })[0];
    expect(latestMpx.status).toBe('failed');
    expect(latestMpx.stageReached).toBe('normalize');
    expect(latestMpx.durationMs).toBeGreaterThanOrEqual(1500);
    expect(latestMpx.durationMs).toBeLessThanOrEqual(2400);
    expect(latestMpx.runId).toMatch(/^run-[0-9a-f]{8}$/);
    expect(service.listRuns({ limit: 1 })[0].startedAt).toBeTruthy();
  });

  test('runs a healthy operator through publish', async () => {
    const run = await service.runPipeline('SWA', { trigger: 'manual' });
    expect(run).toMatchObject({ status: 'succeeded', stageReached: 'publish' });
    expect(run.rowsOut).toBe(run.rowsIn);
    expect(run.rowsIn).toBeGreaterThan(0);
    expect(run.rowsIn).toBeGreaterThanOrEqual(16);
    expect(run.rowsIn).toBeLessThanOrEqual(32);
    expect(new Date(service.ENGINES['598-2041'].lastDataReceivedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(run.startedAt).getTime());
    expect(service.ENGINES['598-2041'].egtMarginC).toBeLessThan(20);
  });

  test('evaluates warning and healthy engine metrics', () => {
    const warning = service.evaluateExceedances({
      esn: 'test-warning',
      family: 'LEAP-1B',
      egtMarginC: 5,
      vibrationN1: 1,
      oilConsumptionQtHr: 0.1,
    });
    expect(warning).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'egtMarginC', level: 'WARNING' }),
    ]));
    expect(service.evaluateExceedances({
      esn: 'test-healthy',
      family: 'LEAP-1B',
      egtMarginC: 40,
      vibrationN1: 1,
      oilConsumptionQtHr: 0.1,
    })).toEqual([]);
  });

  test('serves run and engine routes with validation', async () => {
    const app = testApp();
    const runResponse = await request(app, 'POST', '/api/a693dab5/runs', { operatorCode: 'SWA' });
    expect(runResponse.status).toBe(200);
    expect(runResponse.body.runs[0].status).toBe('succeeded');
    const unknown = await request(app, 'POST', '/api/a693dab5/runs', { operatorCode: 'NOPE' });
    expect(unknown.status).toBe(400);
    const known = await request(app, 'GET', '/api/a693dab5/engines/598-2041');
    expect(known.status).toBe(200);
    expect(Array.isArray(known.body.snapshots)).toBe(true);
    expect(known.body.snapshots.length).toBeGreaterThanOrEqual(6);
    expect(known.body.engine.egtMarginHistory.at(-1)).toBe(known.body.engine.egtMarginC);
    expect(known.body.thresholds).toEqual(expect.objectContaining({
      egtMarginC: expect.objectContaining({ warning: expect.any(Number) }),
    }));
    const missing = await request(app, 'GET', '/api/a693dab5/engines/not-an-engine');
    expect(missing.status).toBe(404);
  });

  test('throttles scheduled alerts and allows manual alerts', async () => {
    await service.runPipeline('MPX', { trigger: 'scheduled' });
    await service.runPipeline('MPX', { trigger: 'scheduled' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    await service.runPipeline('MPX', { trigger: 'manual' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
  });
});

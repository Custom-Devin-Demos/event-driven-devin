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
const service = require('../app/services/verticals/26af2083');
const { GATEWAY_MANIFESTS } = require('../app/services/verticals/26af2083-gateway-manifests');
const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const route = require('../app/routes/verticals/26af2083');

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

describe('26af2083 J1939 telematics ingest', () => {
  test('seeds three gateway families with TCU-G3 assets not reporting', () => {
    const fleet = service.getFleet();
    expect(fleet.account).toMatchObject({ accountNumber: 'CAP-20417' });
    expect(fleet.gateways.map((gateway) => gateway.family)).toEqual(['TCU-G1', 'TCU-G2', 'TCU-G3']);
    const g3 = fleet.gateways.find((gateway) => gateway.family === 'TCU-G3');
    expect(g3.stale).toBe(true);
    expect(g3.decoderRegistered).toBe(false);
    expect(g3.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(fleet.gateways.filter((gateway) => gateway.family !== 'TCU-G3').every((gateway) => gateway.decoderRegistered && !gateway.stale)).toBe(true);
    const g3Assets = fleet.assets.filter((asset) => asset.gateway === 'TCU-G3');
    expect(g3Assets.length).toBeGreaterThan(0);
    expect(g3Assets.every((asset) => asset.stale && asset.reportingStatus === 'NOT_REPORTING')).toBe(true);
    expect(fleet.assets.filter((asset) => asset.gateway !== 'TCU-G3').every((asset) => !asset.stale)).toBe(true);
    expect(fleet.summary.notReporting).toBe(g3Assets.length);
    const latest = service.listRuns({ gateway: 'TCU-G3', limit: 1 })[0];
    expect(latest).toMatchObject({ status: 'failed', stageReached: 'decode_j1939' });
    expect(latest.error.message).toBe("Cannot read properties of undefined (reading 'unpack')");
  });

  test('runs TCU-G1 and TCU-G2 through publish and refreshes their assets', async () => {
    for (const family of ['TCU-G1', 'TCU-G2']) {
      const before = service.getFleet();
      const run = await service.runPipeline(family, { trigger: 'manual' });
      expect(run).toMatchObject({ status: 'succeeded', stageReached: 'publish', gateway: family });
      expect(run.messagesIn).toBeGreaterThan(0);
      expect(run.assetsOut).toBe(before.assets.filter((asset) => asset.gateway === family).length);
      const after = service.getFleet();
      after.assets.filter((asset) => asset.gateway === family).forEach((asset) => {
        expect(new Date(asset.lastReportAt).getTime()).toBeGreaterThanOrEqual(new Date(run.startedAt).getTime());
        expect(asset.stale).toBe(false);
      });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('TCU-G3 fails at decode_j1939 because no method-4 DM1 decoder is registered', async () => {
    expect(GATEWAY_MANIFESTS['TCU-G3'].dm1.spnConversionMethod).toBe(4);
    const run = await service.runPipeline('TCU-G3', {
      trigger: 'manual',
      devinUserId: 'user-from-hub',
      devinOrgId: 'org-from-hub',
      devinEmail: 'dispatch@example.com',
    });
    expect(run).toMatchObject({ status: 'failed', stageReached: 'decode_j1939', assetsOut: 0 });
    expect(run.error).toMatchObject({ name: 'TypeError', stage: 'decode_j1939' });
    expect(run.error.message).toBe("Cannot read properties of undefined (reading 'unpack')");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toEqual(expect.objectContaining({
      gateway: 'TCU-G3', stage: 'decode_j1939', alert_path: 'instant',
    }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toEqual(expect.objectContaining({
      customer: '26af2083',
      errorType: 'TypeError',
      devinUserId: 'user-from-hub',
      devinOrgId: 'org-from-hub',
      devinEmail: 'dispatch@example.com',
    }));
    expect(alert).not.toHaveProperty('slackMemberId');
    expect(alert.tags).toEqual(expect.arrayContaining([{ key: 'dm1_conversion_method', value: '4' }]));
    expect(alert.extra.affectedAssets.length).toBeGreaterThan(0);
  });

  test('throttles scheduled alerts but always alerts manual runs', async () => {
    await service.runPipeline('TCU-G3', { trigger: 'scheduled' });
    await service.runPipeline('TCU-G3', { trigger: 'scheduled' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    await service.runPipeline('TCU-G3', { trigger: 'manual' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('exposes J1939 signals with STALE quality for not-reporting assets', () => {
    const fleet = service.getFleet();
    const stale = fleet.assets.find((asset) => asset.stale);
    const live = fleet.assets.find((asset) => !asset.stale && asset.lamps.RED);
    const staleDetail = service.getAsset(stale.assetId);
    expect(staleDetail.signals.every((signal) => signal.quality === 'STALE' && signal.value === null)).toBe(true);
    const liveDetail = service.getAsset(live.assetId);
    expect(liveDetail.signals.every((signal) => signal.quality === 'GOOD')).toBe(true);
    expect(liveDetail.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ pgn: 61444, spn: 190 }),
      expect.objectContaining({ pgn: 65262, spn: 110 }),
    ]));
    expect(liveDetail.asset.faults[0]).toEqual(expect.objectContaining({
      spn: expect.any(Number), fmi: expect.any(Number), lamp: expect.any(String),
    }));
    expect(service.getAsset('NOPE')).toBeNull();
  });

  test('acknowledges events', () => {
    const open = service.EVENTS.find((event) => event.state === 'OPEN');
    const acked = service.acknowledgeEvent(open.id, 'jdoe');
    expect(acked).toMatchObject({ state: 'ACKED', ackBy: 'jdoe' });
    expect(service.acknowledgeEvent('EV-0', 'jdoe')).toBeNull();
  });

  test('serves fleet, asset, run and ack routes with validation', async () => {
    const app = testApp();
    const fleet = await request(app, 'GET', '/api/26af2083/fleet');
    expect(fleet.status).toBe(200);
    expect(fleet.body.assets.length).toBeGreaterThan(0);
    const assetId = fleet.body.assets[0].assetId;
    const asset = await request(app, 'GET', `/api/26af2083/assets/${assetId}`);
    expect(asset.status).toBe(200);
    expect(asset.body.asset.assetId).toBe(assetId);
    expect((await request(app, 'GET', '/api/26af2083/assets/NOPE')).status).toBe(404);
    const healthy = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G2' });
    expect(healthy.status).toBe(200);
    expect(healthy.body.runs[0].status).toBe('succeeded');
    const failing = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G3', devinOrgId: 'org-x' });
    expect(failing.status).toBe(200);
    expect(failing.body.runs[0]).toMatchObject({ status: 'failed', stageReached: 'decode_j1939' });
    expect(createSessionAndAlert.mock.calls.at(-1)[0].devinOrgId).toBe('org-x');
    expect((await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G9' })).status).toBe(400);
    const all = await request(app, 'POST', '/api/26af2083/runs', {});
    expect(all.body.runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded', 'failed']);
    const runs = await request(app, 'GET', '/api/26af2083/runs?limit=5&gateway=TCU-G3');
    expect(runs.body.runs.length).toBeLessThanOrEqual(5);
    expect(runs.body.runs.every((run) => run.gateway === 'TCU-G3')).toBe(true);
    const event = service.EVENTS.find((candidate) => candidate.state === 'OPEN');
    const ack = await request(app, 'POST', `/api/26af2083/events/${event.id}/ack`, { user: 'jdoe' });
    expect(ack.status).toBe(200);
    expect(ack.body.event.state).toBe('ACKED');
    expect((await request(app, 'POST', '/api/26af2083/events/EV-0/ack', {})).status).toBe(404);
  });
});

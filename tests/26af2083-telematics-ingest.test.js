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

function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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

  test('keeps an acknowledged PM event acknowledged when its hours-to-service title changes', async () => {
    const serviceEvent = service.EVENTS.find((event) => event.type === 'SERVICE' && event.state === 'OPEN');
    expect(serviceEvent).toBeDefined();
    const { id, assetId, gateway, title } = serviceEvent;
    expect(service.acknowledgeEvent(id, 'jdoe').state).toBe('ACKED');
    service.ASSETS[assetId].hours += 3;
    const run = await service.runPipeline(gateway, { trigger: 'manual' });
    expect(run.status).toBe('succeeded');
    const open = service.EVENTS.filter((event) => event.assetId === assetId && event.type === 'SERVICE' && event.state !== 'CLOSED');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id, state: 'ACKED', ackBy: 'jdoe' });
    expect(open[0].title).toMatch(/^PM \d+ h/);
    expect(open[0].title).not.toBe(title);
  });

  test('accumulates utilization per account-local day without double-counting a re-run', async () => {
    const pinned = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(pinned);
    const assetId = Object.values(service.ASSETS).find((asset) => asset.gateway === 'TCU-G1').assetId;
    const seeded = service.ASSETS[assetId].utilization;
    await service.runPipeline('TCU-G1', { trigger: 'manual' });
    const first = service.ASSETS[assetId].utilization;
    expect(first.workedTodayMin + first.idleTodayMin).toBeGreaterThanOrEqual(seeded.workedTodayMin + seeded.idleTodayMin);
    expect(first.workedTodayMin + first.idleTodayMin).toBeLessThanOrEqual(seeded.workedTodayMin + seeded.idleTodayMin + 5);
    await service.runPipeline('TCU-G1', { trigger: 'manual' });
    const second = service.ASSETS[assetId].utilization;
    expect(second.workedTodayMin + second.idleTodayMin).toBeLessThanOrEqual(seeded.workedTodayMin + seeded.idleTodayMin + 5);
    expect(second.lastBucket).toBe(first.lastBucket);
    clock.mockRestore();

    service.resetStore(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const stale = service.ASSETS[assetId].utilization;
    expect(stale.workedTodayMin + stale.idleTodayMin).toBeGreaterThan(5);
    await service.runPipeline('TCU-G1', { trigger: 'manual' });
    const reset = service.ASSETS[assetId].utilization;
    expect(reset.date).not.toBe(stale.date);
    expect(reset.workedTodayMin + reset.idleTodayMin).toBeLessThanOrEqual(5);
  });

  test('healthy gateways stay fresh with the scheduler off while TCU-G3 assets stay not reporting', () => {
    const seededAt = Date.now();
    service.resetStore(seededAt);
    const g3RunsBefore = service.listRuns({ gateway: 'TCU-G3', limit: 50 }).length;
    const later = seededAt + 3 * 60 * 60 * 1000;
    const fleet = service.getFleet(later);
    fleet.assets.forEach((asset) => {
      if (asset.gateway === 'TCU-G3') {
        expect(asset.stale).toBe(true);
        expect(asset.reportingStatus).toBe('NOT_REPORTING');
      } else {
        expect(asset.stale).toBe(false);
        expect(later - new Date(asset.lastReportAt).getTime()).toBeLessThan(fleet.staleAfterMs);
      }
    });
    expect(fleet.gateways.find((gateway) => gateway.family === 'TCU-G3').stale).toBe(true);
    expect(service.listRuns({ gateway: 'TCU-G3', limit: 50 }).length).toBe(g3RunsBefore);
    expect(service.listRuns({ gateway: 'TCU-G1', limit: 1 })[0]).toMatchObject({ trigger: 'scheduled', status: 'succeeded', stageReached: 'publish' });
  });

  test('acknowledges events', () => {
    const open = service.EVENTS.find((event) => event.state === 'OPEN');
    const acked = service.acknowledgeEvent(open.id, 'jdoe');
    expect(acked).toMatchObject({ state: 'ACKED', ackBy: 'jdoe' });
    expect(service.acknowledgeEvent('EV-0', 'jdoe')).toBeNull();
  });

  test('healthy-gateway replay advances account-day utilization and resets it at account-local midnight', () => {
    const timezone = service.getFleet(Date.now()).account.timezone;
    const accountDate = (at) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).format(new Date(at));
    const hour = 60 * 60 * 1000;
    const anchor = Math.floor(Date.now() / hour) * hour;
    const midnight = Array.from({ length: 30 }, (_, index) => anchor + index * hour)
      .find((at) => accountDate(at) !== accountDate(at + hour));
    const midnightAt = midnight + hour;

    // Same day: replay keeps adding worked/idle minutes.
    service.resetStore(midnightAt - 6 * hour);
    const workingId = Object.values(service.ASSETS)
      .find((asset) => asset.gateway === 'TCU-G1' && asset.utilization.workedTodayMin + asset.utilization.idleTodayMin > 0).assetId;
    const seeded = { ...service.ASSETS[workingId].utilization };
    service.getFleet(midnightAt - 3 * hour);
    const sameDay = service.ASSETS[workingId].utilization;
    expect(sameDay.date).toBe(seeded.date);
    expect(sameDay.workedTodayMin + sameDay.idleTodayMin).toBeGreaterThan(seeded.workedTodayMin + seeded.idleTodayMin);
    expect(sameDay.lastBucket).toBeGreaterThan(midnightAt - 6 * hour);

    // Across midnight: counters restart on the new account-local date.
    service.resetStore(midnightAt - hour);
    const yesterday = { ...service.ASSETS[workingId].utilization };
    expect(yesterday.workedTodayMin + yesterday.idleTodayMin).toBeGreaterThan(60);
    const later = midnightAt + hour;
    const fleet = service.getFleet(later);
    const today = service.ASSETS[workingId].utilization;
    expect(today.date).toBe(accountDate(later));
    expect(today.date).not.toBe(yesterday.date);
    expect(today.workedTodayMin + today.idleTodayMin).toBeLessThanOrEqual(75);
    expect(fleet.assets.find((asset) => asset.assetId === workingId).stale).toBe(false);
  });

  test('rejects inherited object properties as gateway families', async () => {
    expect(service.getGatewayManifest('constructor')).toBeNull();
    expect(service.getAsset('constructor')).toBeNull();
    const app = testApp();
    expect((await request(app, 'GET', '/api/26af2083/assets/constructor')).status).toBe(404);
    const run = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'constructor' });
    expect(run.status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
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

  test('only forwards string hub identity fields into the alert payload', async () => {
    const app = testApp();
    const response = await request(app, 'POST', '/api/26af2083/runs', {
      gateway: 'TCU-G3',
      devinOrgId: { nested: true },
      devinUserId: 42,
      devinEmail: '  dispatch@example.com ',
      slackMemberId: 'U0INJECTED',
    });
    expect(response.status).toBe(200);
    const payload = createSessionAndAlert.mock.calls.at(-1)[0];
    expect(payload.devinOrgId).toBeUndefined();
    expect(payload.devinUserId).toBeUndefined();
    expect(payload.devinEmail).toBe('dispatch@example.com');
    expect(payload.slackMemberId).toBeUndefined();
  });

  test('rejects side-effecting POSTs without the session secret when SESSION_SECRET is set', async () => {
    process.env.SESSION_SECRET = 'fleet-secret';
    try {
      const app = testApp();
      const denied = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G3' });
      expect(denied.status).toBe(401);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
      const event = service.EVENTS.find((candidate) => candidate.state === 'OPEN');
      const deniedAck = await request(app, 'POST', `/api/26af2083/events/${event.id}/ack`, { user: 'jdoe' });
      expect(deniedAck.status).toBe(401);
      expect(service.EVENTS.find((candidate) => candidate.id === event.id).state).toBe('OPEN');
      const wrong = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G3' }, { 'x-session-secret': 'nope' });
      expect(wrong.status).toBe(403);
      const allowed = await request(app, 'POST', '/api/26af2083/runs', { gateway: 'TCU-G3' }, { 'x-session-secret': 'fleet-secret' });
      expect(allowed.status).toBe(200);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
      expect((await request(app, 'GET', '/api/26af2083/fleet')).status).toBe(200);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});

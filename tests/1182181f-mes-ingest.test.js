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

  test('publish rolls interval counts into the cell read model without double-counting a re-run', async () => {
    const pinned = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(pinned);
    const before = service.getLine('L1');
    const cellBefore = before.cells[0];
    const first = await service.runPipeline('L1', { trigger: 'manual' });
    expect(first.status).toBe('succeeded');
    const afterFirst = service.getLine('L1');
    const cellAfterFirst = afterFirst.cells.find((cell) => cell.cellId === cellBefore.cellId);
    expect(cellAfterFirst.partsGood).toBe(cellBefore.partsGood + cellAfterFirst.goodCount);
    expect(cellAfterFirst.partsReject).toBe(cellBefore.partsReject + cellAfterFirst.rejectCount);
    expect(cellAfterFirst.timeline.length).toBeGreaterThan(0);
    expect(cellAfterFirst.timeline.at(-1).end).toBeGreaterThanOrEqual((cellBefore.timeline.at(-1) || { end: 0 }).end);
    expect(afterFirst.line.shiftGoodCount).toBe(before.line.shiftGoodCount + afterFirst.line.lastInterval.goodCount);

    // Same 5-minute bucket → the manual re-run replaces the interval instead of adding it again.
    const second = await service.runPipeline('L1', { trigger: 'manual' });
    expect(second.status).toBe('succeeded');
    const afterSecond = service.getLine('L1');
    const cellAfterSecond = afterSecond.cells.find((cell) => cell.cellId === cellBefore.cellId);
    expect(cellAfterSecond.partsGood).toBe(cellBefore.partsGood + cellAfterSecond.goodCount);
    expect(afterSecond.line.shiftGoodCount).toBe(before.line.shiftGoodCount + afterSecond.line.lastInterval.goodCount);
    expect(afterSecond.line.shiftGoodCount).toBeLessThan(before.line.shiftGoodCount + 2 * afterSecond.line.lastInterval.goodCount);
    clock.mockRestore();
  });

  test('manual runs straddling an aligned interval boundary credit the overlap only once', async () => {
    const intervalMs = 15 * 60 * 1000;
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime();
    // A boundary well inside the shift so neither run is clipped by the shift start.
    const boundary = Math.ceil((shiftStart + 2 * 60 * 60 * 1000) / intervalMs) * intervalMs;
    service.resetStore(boundary - 60 * 60 * 1000);
    const before = service.LINES.L1.shiftGoodCount;

    const clock = jest.spyOn(Date, 'now').mockReturnValue(boundary - 60 * 1000);
    expect((await service.runPipeline('L1', { trigger: 'manual' })).status).toBe('succeeded');
    const first = service.LINES.L1.lastInterval.goodCount;
    clock.mockReturnValue(boundary + 60 * 1000);
    expect((await service.runPipeline('L1', { trigger: 'manual' })).status).toBe('succeeded');
    clock.mockRestore();

    const second = service.LINES.L1.lastInterval.goodCount;
    // Two minutes apart: the 13 minutes the second window re-sampled are withdrawn from the first.
    expect(service.LINES.L1.shiftGoodCount).toBe(before + first - Math.round(first * (13 / 15)) + second);
    expect(service.LINES.L1.shiftGoodCount).toBeLessThan(before + first + second);
    expect(service.LINES.L1.shiftGoodCount).toBeGreaterThanOrEqual(before + second);
  });

  test('runs a full interval apart add both windows in full', async () => {
    const intervalMs = 15 * 60 * 1000;
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime();
    const at = Math.ceil((shiftStart + 2 * 60 * 60 * 1000) / intervalMs) * intervalMs;
    service.resetStore(at - 60 * 60 * 1000);
    const before = service.LINES.L1.shiftGoodCount;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(at);
    await service.runPipeline('L1', { trigger: 'manual' });
    const first = service.LINES.L1.lastInterval.goodCount;
    clock.mockReturnValue(at + intervalMs);
    await service.runPipeline('L1', { trigger: 'manual' });
    clock.mockRestore();
    expect(service.LINES.L1.shiftGoodCount).toBe(before + first + service.LINES.L1.lastInterval.goodCount);
  });

  test('two runs inside the first 15 minutes of a shift credit only the in-shift minutes once', async () => {
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime() + 8 * 60 * 60 * 1000;
    service.resetStore(shiftStart - 60 * 60 * 1000);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(shiftStart + 10 * 60 * 1000);
    await service.runPipeline('L1', { trigger: 'manual' });
    const first = service.LINES.L1.lastInterval.goodCount;
    expect(service.LINES.L1.shiftGoodCount).toBe(first);
    clock.mockReturnValue(shiftStart + 12 * 60 * 1000);
    await service.runPipeline('L1', { trigger: 'manual' });
    clock.mockRestore();
    // The second window re-samples every in-shift minute the first credited.
    expect(service.LINES.L1.shiftGoodCount).toBe(service.LINES.L1.lastInterval.goodCount);
    const cells = service.getPlant(shiftStart + 12 * 60 * 1000).cells.filter((cell) => cell.lineCode === 'L1');
    cells.forEach((cell) => expect(cell.partsGood).toBe(service.CELLS[cell.cellId].lastInterval.goodCount));
  });

  test('replays every missed interval of the current shift after a long idle period', () => {
    // The shift after the current one, so a 5 h offset is guaranteed to stay inside it.
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime() + 8 * 60 * 60 * 1000;
    const seededAt = shiftStart - 20 * 60 * 60 * 1000;
    service.resetStore(seededAt);
    const seededRuns = service.listRuns({ lineCode: 'L1', limit: 200 }).filter((run) => run.trigger === 'scheduled').length;
    const later = shiftStart + 5 * 60 * 60 * 1000 + 7 * 60 * 1000;
    const plant = service.getPlant(later);
    const line = plant.lines.find((candidate) => candidate.code === 'L1');
    expect(new Date(plant.shift.startsAt).getTime()).toBe(shiftStart);
    expect(line.shiftStartsAt).toBe(plant.shift.startsAt);
    const shiftRuns = service.listRuns({ lineCode: 'L1', limit: 200 })
      .filter((run) => new Date(run.startedAt).getTime() >= shiftStart && run.trigger === 'scheduled');
    // Every 15-minute job since the shift began (5 h → 20), not just the last eight.
    expect(shiftRuns.length).toBeGreaterThanOrEqual(20);
    const all = service.listRuns({ lineCode: 'L1', limit: 200 }).filter((run) => run.trigger === 'scheduled');
    // Pre-shift jobs are bounded history, not the whole 20 h gap.
    expect(all.length - shiftRuns.length).toBeLessThanOrEqual(seededRuns + 16 + 1);
    const cell = plant.cells.find((candidate) => candidate.lineCode === 'L1' && candidate.category === 'running');
    expect(cell.timeline.at(-1).end).toBeGreaterThan(plant.shift.elapsedMin - 16);
    expect(cell.partsGood).toBeGreaterThan(cell.goodCount * 10);
  });

  test('resets shift counters on the first publish of a new shift', async () => {
    service.resetStore(Date.now() - 9 * 60 * 60 * 1000);
    const seeded = service.LINES.L2;
    expect(seeded.shiftGoodCount).toBeGreaterThan(0);
    const staleShift = seeded.shiftStartsAt;
    const run = await service.runPipeline('L2', { trigger: 'manual' });
    expect(run.status).toBe('succeeded');
    const line = service.LINES.L2;
    expect(line.shiftStartsAt).not.toBe(staleShift);
    expect(line.shiftStartsAt).toBe(service.getPlant().shift.startsAt);
    expect(line.shiftGoodCount).toBe(line.lastInterval.goodCount);
    expect(line.shiftRejectCount).toBe(line.lastInterval.rejectCount);
    const cells = Object.values(service.CELLS).filter((cell) => cell.lineCode === 'L2');
    cells.forEach((cell) => {
      expect(cell.partsGood).toBe(cell.goodCount);
      expect(cell.timeline.every((segment) => segment.end <= service.getPlant().shift.elapsedMin + 1)).toBe(true);
    });
  });

  test('healthy lines stay fresh with the scheduler off while L4 stays stale', () => {
    const seededAt = Date.now();
    service.resetStore(seededAt);
    const l4RunsBefore = service.listRuns({ lineCode: 'L4', limit: 50 }).length;
    const later = seededAt + 3 * 60 * 60 * 1000;
    const plant = service.getPlant(later);
    plant.lines.filter((line) => line.code !== 'L4').forEach((line) => {
      expect(line.stale).toBe(false);
      expect(later - new Date(line.lastPublishedAt).getTime()).toBeLessThan(plant.staleAfterMs);
    });
    const l4 = plant.lines.find((line) => line.code === 'L4');
    expect(l4.stale).toBe(true);
    expect(l4.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(service.listRuns({ lineCode: 'L4', limit: 50 }).length).toBe(l4RunsBefore);
    const replayed = service.listRuns({ lineCode: 'L1', limit: 1 })[0];
    expect(replayed).toMatchObject({ trigger: 'scheduled', status: 'succeeded', stageReached: 'publish' });
    const cell = plant.cells.find((candidate) => candidate.lineCode === 'L1');
    expect(later - new Date(cell.lastSampleAt).getTime()).toBeLessThan(plant.staleAfterMs);
  });

  test('healthy-line replay advances shift totals, cell timelines and utilization like real publishes', () => {
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime();
    const seededAt = shiftStart + 60 * 60 * 1000;
    service.resetStore(seededAt);
    const seededLine = { ...service.LINES.L1 };
    const seededCell = { ...Object.values(service.CELLS).find((cell) => cell.lineCode === 'L1' && cell.category === 'running') };
    const later = seededAt + 2 * 60 * 60 * 1000;
    const plant = service.getPlant(later);
    const line = plant.lines.find((candidate) => candidate.code === 'L1');
    expect(line.shiftStartsAt).toBe(seededLine.shiftStartsAt);
    expect(line.shiftGoodCount).toBeGreaterThan(seededLine.shiftGoodCount);
    expect(later - line.lastIntervalBucket).toBeLessThan(35 * 60 * 1000);
    const cell = plant.cells.find((candidate) => candidate.cellId === seededCell.cellId);
    expect(cell.partsGood).toBeGreaterThan(seededCell.partsGood);
    expect(cell.timeline.at(-1).end).toBeGreaterThan(seededCell.timeline.at(-1).end);
    expect(cell.timeline.at(-1).end).toBeLessThanOrEqual(plant.shift.elapsedMin);
    expect(cell.utilization).toBeGreaterThan(0);
    expect(cell.utilization).toBeLessThanOrEqual(1);
  });

  test('healthy-line replay rolls the shift over when the missed intervals cross a shift boundary', () => {
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime();
    const seededAt = shiftStart + 7 * 60 * 60 * 1000;
    service.resetStore(seededAt);
    const seededLine = { ...service.LINES.L1 };
    const later = seededAt + 2 * 60 * 60 * 1000;
    const plant = service.getPlant(later);
    const line = plant.lines.find((candidate) => candidate.code === 'L1');
    expect(plant.shift.startsAt).not.toBe(seededLine.shiftStartsAt);
    expect(line.shiftStartsAt).toBe(plant.shift.startsAt);
    expect(line.shiftGoodCount).toBeLessThan(seededLine.shiftGoodCount);
    expect(line.shiftGoodCount).toBeGreaterThan(0);
    plant.cells.filter((cell) => cell.lineCode === 'L1').forEach((cell) => {
      expect(cell.timeline.every((segment) => segment.start >= 0 && segment.end <= plant.shift.elapsedMin)).toBe(true);
      expect(cell.utilization).toBeLessThanOrEqual(1);
    });
  });

  test('clips the first interval after a shift boundary so utilization cannot exceed 100 %', async () => {
    const shiftStart = new Date(service.getPlant(Date.now()).shift.startsAt).getTime();
    service.resetStore(shiftStart - 30 * 60 * 1000);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(shiftStart + 60 * 1000);
    const run = await service.runPipeline('L1', { trigger: 'manual' });
    clock.mockRestore();
    expect(run.status).toBe('succeeded');
    const line = service.LINES.L1;
    expect(line.shiftGoodCount).toBe(line.lastInterval.goodCount);
    expect(line.shiftGoodCount).toBeLessThanOrEqual(Math.ceil(line.lastInterval.goodCount));
    Object.values(service.CELLS).filter((cell) => cell.lineCode === 'L1').forEach((cell) => {
      expect(cell.utilization).toBeLessThanOrEqual(1);
      expect(cell.timeline.every((segment) => segment.start >= 0 && segment.end <= 1)).toBe(true);
      expect(cell.partsGood).toBeLessThanOrEqual(Math.ceil(cell.goodCount / 15) + 1);
    });
  });

  test('rejects inherited object properties as line codes', async () => {
    expect(service.getLineManifest('constructor')).toBeNull();
    expect(service.getLine('constructor')).toBeNull();
    const app = testApp();
    expect((await request(app, 'GET', '/api/1182181f/lines/constructor')).status).toBe(404);
    const run = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'constructor' });
    expect(run.status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
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

  test('only forwards string hub identity fields into the alert payload', async () => {
    const app = testApp();
    const response = await request(app, 'POST', '/api/1182181f/runs', {
      lineCode: 'L4',
      devinOrgId: { nested: true },
      devinUserId: ['array'],
      devinEmail: '  ops@example.com ',
      slackMemberId: 'U0INJECTED',
      lineName: 'spoofed',
    });
    expect(response.status).toBe(200);
    const payload = createSessionAndAlert.mock.calls.at(-1)[0];
    expect(payload.devinOrgId).toBeUndefined();
    expect(payload.devinUserId).toBeUndefined();
    expect(payload.devinEmail).toBe('ops@example.com');
    expect(payload.slackMemberId).toBeUndefined();
    expect(payload.extra.lineName).toBe(LINE_MANIFESTS.L4.name);
  });

  test('rejects side-effecting POSTs without the session secret when SESSION_SECRET is set', async () => {
    process.env.SESSION_SECRET = 'plant-secret';
    try {
      const app = testApp();
      const denied = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'L4' });
      expect(denied.status).toBe(401);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
      const alarm = service.ALARMS.find((candidate) => candidate.state === 'ACTIVE_UNACK');
      const deniedAck = await request(app, 'POST', `/api/1182181f/alarms/${alarm.id}/ack`, { user: 'jdoe' });
      expect(deniedAck.status).toBe(401);
      expect(service.ALARMS.find((candidate) => candidate.id === alarm.id).state).toBe('ACTIVE_UNACK');
      const wrong = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'L4' }, { 'x-session-secret': 'nope' });
      expect(wrong.status).toBe(403);
      const allowed = await request(app, 'POST', '/api/1182181f/runs', { lineCode: 'L4' }, { 'x-session-secret': 'plant-secret' });
      expect(allowed.status).toBe(200);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
      expect((await request(app, 'GET', '/api/1182181f/plant')).status).toBe(200);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});

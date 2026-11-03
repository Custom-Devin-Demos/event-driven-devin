/* global describe, expect, test, beforeEach, beforeAll, jest */

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

const express = require('express');
const http = require('http');
const service = require('../app/services/verticals/b6e7eac1');
const seed = require('../app/services/verticals/b6e7eac1-seed');
const { Sentry } = require('../app/telemetry/sentry');
const route = require('../app/routes/verticals/b6e7eac1');

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
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

const EMPIRE_EVENT = { eventId: 'evt-5b21e0aa', dealerCode: 'EMPIRE', contractId: 'RC-EMP-100232', yard: 'PHX-02' };
const FINNING_EVENT = { eventId: 'evt-9c04d1f2', dealerCode: 'FINNING-CA', contractId: 'RC-FIN-300077' };

beforeAll(() => service.ready);

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.DEVIN_WEBHOOK_URL_B6E7EAC1;
  delete process.env.DEVIN_WEBHOOK_SECRET_B6E7EAC1;
  await service.resetDemo();
});

describe('seed and reset', () => {
  test('reset reloads 10 contract lines and re-parks exactly the two stuck events through the real pipeline', async () => {
    const result = await service.resetDemo();
    expect(result).toMatchObject({ success: true, contractLines: 10, deadLetters: [EMPIRE_EVENT.eventId, FINNING_EVENT.eventId] });
    expect(service.listDeadLetters()).toHaveLength(2);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('dead letters carry a real reason and the full original message', () => {
    const byId = Object.fromEntries(service.listDeadLetters().map((d) => [d.eventId, d]));
    expect(byId[EMPIRE_EVENT.eventId].errorCode).toBe('WAREHOUSE_UNMAPPED');
    expect(byId[EMPIRE_EVENT.eventId].reason).toContain("'PHX-02'");
    expect(byId[EMPIRE_EVENT.eventId].reason).toContain("legal entity 'emp'");
    expect(byId[FINNING_EVENT.eventId].errorCode).toBe('DEALER_UNKNOWN');
    expect(byId[FINNING_EVENT.eventId].reason).toContain("'FINNING-CA'");
    expect(byId[FINNING_EVENT.eventId].body.fuelPercent).toBe(110);
    expect(byId[FINNING_EVENT.eventId].deliveryCount).toBe(1);
  });

  test('the stuck contracts stay OnRent until their return is applied', () => {
    expect(service.getContractLine('emp', 'RC-EMP-100232').state).toBe('OnRent');
    expect(service.getContractLine('fin', 'RC-FIN-300077').state).toBe('OnRent');
  });
});

describe('mapping', () => {
  const base = { eventId: 'evt-t', dealerCode: 'EMPIRE', contractId: 'RC-EMP-100219', serialNumber: 'X', returnYard: 'MESA-01', hoursMeter: 1000, fuelPercent: 70, returnedAt: seed.SEED_NOW };

  test('maps a known dealer and yard to its legal entity and warehouse', () => {
    expect(service.mapReturnEvent(base)).toMatchObject({ dataAreaId: 'emp', returnWarehouseId: 'EMP-MESA-01', fuelPercent: 70, warnings: [] });
  });

  test('dealer code lookup ignores case and whitespace', () => {
    expect(service.mapReturnEvent({ ...base, dealerCode: ' empire ' }).dataAreaId).toBe('emp');
  });

  test('out-of-range fuel is clamped with a warning rather than rejected', () => {
    expect(service.mapReturnEvent({ ...base, fuelPercent: 110 })).toMatchObject({ fuelPercent: 100, warnings: [expect.stringContaining('110')] });
    expect(service.mapReturnEvent({ ...base, fuelPercent: -5 }).fuelPercent).toBe(0);
  });

  test('unknown dealer and unmapped yard are mapping errors with their codes', () => {
    expect(() => service.mapReturnEvent({ ...base, dealerCode: 'NOSUCH' })).toThrow(expect.objectContaining({ errorCode: 'DEALER_UNKNOWN' }));
    expect(() => service.mapReturnEvent({ ...base, returnYard: 'ZZZ-09' })).toThrow(expect.objectContaining({ errorCode: 'WAREHOUSE_UNMAPPED' }));
  });
});

describe('processing and replay', () => {
  test('a valid return moves the contract line from OnRent to Returned', async () => {
    const result = await service.processReturnEvent({ eventId: 'evt-ok', dealerCode: 'ALTORF', contractId: 'RC-ALT-200411', serialNumber: 'X', returnYard: 'PEO-01', hoursMeter: 2010, fuelPercent: 55, returnedAt: seed.SEED_NOW });
    expect(result.status).toBe('Applied');
    expect(service.getContractLine('alt', 'RC-ALT-200411')).toMatchObject({ state: 'Returned', returnWarehouseId: 'ALT-PEO-01', returnHoursMeter: 2010 });
  });

  test('a return for a line that is not OnRent is dead-lettered and reported to Sentry', async () => {
    const result = await service.processReturnEvent({ eventId: 'evt-dup', dealerCode: 'ALTORF', contractId: 'RC-ALT-200377', serialNumber: 'X', returnYard: 'CHI-01', hoursMeter: 700, fuelPercent: 50, returnedAt: seed.SEED_NOW });
    expect(result.status).toBe('DeadLettered');
    expect(result.deadLetter.errorCode).toBe('CONTRACT_NOT_ON_RENT');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('replay without a fix fails again and increments the delivery count', async () => {
    const result = await service.replayDeadLetter(EMPIRE_EVENT.eventId);
    expect(result.status).toBe('DeadLettered');
    expect(service.listDeadLetters().find((d) => d.eventId === EMPIRE_EVENT.eventId).deliveryCount).toBe(2);
  });

  test('replay after the mapping gap is closed applies the return and completes the dead letter', async () => {
    seed.WAREHOUSE_MAP.emp['PHX-02'] = 'EMP-PHX-02';
    try {
      const result = await service.replayDeadLetter(EMPIRE_EVENT.eventId);
      expect(result.status).toBe('Applied');
      expect(service.getContractLine('emp', 'RC-EMP-100232')).toMatchObject({ state: 'Returned', returnWarehouseId: 'EMP-PHX-02' });
      expect(service.listDeadLetters().map((d) => d.eventId)).toEqual([FINNING_EVENT.eventId]);
    } finally {
      delete seed.WAREHOUSE_MAP.emp['PHX-02'];
    }
  });

  test('replay of an unknown event returns null', async () => {
    expect(await service.replayDeadLetter('evt-nope')).toBeNull();
  });
});

describe('alert → Devin webhook', () => {
  test('payload is the trimmed Azure Monitor common alert schema for the dead-letter rule', () => {
    const payload = service.buildAlertPayload({ pageUrl: 'http://localhost/b6e7eac1' });
    expect(payload.schemaId).toBe('azureMonitorCommonAlertSchema');
    expect(payload.data.essentials).toMatchObject({ alertRule: 'converge-rentalsync-deadletter-count', severity: 'Sev2', monitorCondition: 'Fired' });
    expect(payload.data.alertContext.condition.allOf[0].metricValue).toBe(2);
    expect(payload.data.customProperties.deadLetters).toEqual([EMPIRE_EVENT.eventId, FINNING_EVENT.eventId]);
    expect(payload.data.customProperties.repo).toBe('COG-GTM/event-driven-devin');
    expect(JSON.stringify(payload)).not.toContain('CAT0320GCXKJ00912');
  });

  test('without webhook configuration nothing is sent and the payload is still returned', async () => {
    const result = await service.fireAlert({});
    expect(result.sent).toBe(false);
    expect(result.message).toContain('not configured');
    expect(result.payload.data.essentials.alertRule).toBe('converge-rentalsync-deadletter-count');
  });

  test('with configuration the payload is POSTed with the X-Webhook-Secret header', async () => {
    process.env.DEVIN_WEBHOOK_URL_B6E7EAC1 = 'https://devin.example/api/webhooks/automations/org/auto-1';
    process.env.DEVIN_WEBHOOK_SECRET_B6E7EAC1 = 'shh';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 202, text: async () => '{"ok":true}' });
    try {
      const result = await service.fireAlert({ devinEmail: 'presenter@example.com' });
      expect(result).toMatchObject({ success: true, sent: true, statusCode: 202 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(process.env.DEVIN_WEBHOOK_URL_B6E7EAC1);
      expect(init.method).toBe('POST');
      expect(init.headers['X-Webhook-Secret']).toBe('shh');
      expect(JSON.parse(init.body).data.essentials.alertRule).toBe('converge-rentalsync-deadletter-count');
      expect(service.getState().lastAlert).toMatchObject({ sent: true, statusCode: 202 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('a rejected webhook is reported, not retried', async () => {
    process.env.DEVIN_WEBHOOK_URL_B6E7EAC1 = 'https://devin.example/hook';
    process.env.DEVIN_WEBHOOK_SECRET_B6E7EAC1 = 'shh';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, text: async () => 'bad secret' });
    try {
      const result = await service.fireAlert({});
      expect(result).toMatchObject({ success: false, sent: false, statusCode: 401 });
      expect(result.message).toContain('401');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('HTTP routes', () => {
  test('GET /api/b6e7eac1/deadletters lists both parked messages', async () => {
    const res = await request(makeApp(), 'GET', '/api/b6e7eac1/deadletters');
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.eventId)).toEqual([EMPIRE_EVENT.eventId, FINNING_EVENT.eventId]);
  });

  test('GET /api/b6e7eac1/contracts/:dataAreaId is scoped to one legal entity and 404s for unknown ones', async () => {
    const emp = await request(makeApp(), 'GET', '/api/b6e7eac1/contracts/emp');
    expect(emp.status).toBe(200);
    expect(emp.body).toHaveLength(4);
    expect(emp.body.every((l) => l.dataAreaId === 'emp')).toBe(true);
    const nope = await request(makeApp(), 'GET', '/api/b6e7eac1/contracts/xyz');
    expect(nope.status).toBe(404);
    expect(nope.headers['content-type']).toContain('application/problem+json');
  });

  test('POST /api/b6e7eac1/returns rejects an invalid event with 400 problem details and no alert', async () => {
    const res = await request(makeApp(), 'POST', '/api/b6e7eac1/returns', { eventId: 'evt-x', dealerCode: 'EMPIRE' });
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThanOrEqual(3);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('POST /api/b6e7eac1/returns applies a good event (200) and parks a bad one (202)', async () => {
    const good = await request(makeApp(), 'POST', '/api/b6e7eac1/returns', { eventId: 'evt-g', dealerCode: 'FINNING', contractId: 'RC-FIN-300069', serialNumber: 'X', returnYard: 'CGY-01', hoursMeter: 900, fuelPercent: 60, returnedAt: seed.SEED_NOW });
    expect(good.status).toBe(200);
    expect(good.body.contractLine.state).toBe('Returned');
    const bad = await request(makeApp(), 'POST', '/api/b6e7eac1/returns', { eventId: 'evt-b', dealerCode: 'FINNING', contractId: 'RC-FIN-300069', serialNumber: 'X', returnYard: 'NOPE-01', hoursMeter: 900, fuelPercent: 60, returnedAt: seed.SEED_NOW });
    expect(bad.status).toBe(202);
    expect(bad.body.deadLetter.errorCode).toBe('WAREHOUSE_UNMAPPED');
  });

  test('replay returns 409 while the gap exists and 404 for an unknown id', async () => {
    const stuck = await request(makeApp(), 'POST', `/api/b6e7eac1/deadletters/${EMPIRE_EVENT.eventId}/replay`);
    expect(stuck.status).toBe(409);
    const nope = await request(makeApp(), 'POST', '/api/b6e7eac1/deadletters/evt-nope/replay');
    expect(nope.status).toBe(404);
  });

  test('fire-alert is refused with 503 when the webhook is not configured; reset returns the opening state', async () => {
    const fire = await request(makeApp(), 'POST', '/api/b6e7eac1/alerts/fire', {});
    expect(fire.status).toBe(503);
    expect(fire.body.payload.data.essentials.alertRule).toBe('converge-rentalsync-deadletter-count');
    const reset = await request(makeApp(), 'POST', '/api/b6e7eac1/alerts/reset');
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ success: true, contractLines: 10, deadLetters: [EMPIRE_EVENT.eventId, FINNING_EVENT.eventId] });
  });

  test('GET /api/b6e7eac1/state carries what the console renders', async () => {
    const res = await request(makeApp(), 'GET', '/api/b6e7eac1/state');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rule: 'converge-rentalsync-deadletter-count', severity: 'Sev2', condition: 'Fired', deadLetterCount: 2, webhookConfigured: false });
    expect(res.body.contracts).toHaveLength(10);
  });
});

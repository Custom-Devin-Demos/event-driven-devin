/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() }, initSentry: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ tracer: { trace: jest.fn((_name, _options, fn) => fn()) }, incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn() }));
jest.mock('../app/services/datadog-incident-slack', () => ({ queueIncidentChannelInvites: jest.fn() }));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { queueIncidentChannelInvites } = require('../app/services/datadog-incident-slack');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { tracer, incrementMetric } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const { getOncallSkin } = require('../config/oncall-skins');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const SLUG = '5e57909d';
const API = '/api/oncall/regions/bill-pay/submit';
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('../app/routes/oncall'));
  app.use(require('../app/routes/oncall-verticals'));
  app.use(require('../app/routes/verticals/4da81799'));
  server = http.createServer(app).listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await stopGateway();
});

beforeEach(() => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  createDevinSession.mockResolvedValue({ sessionId: 'regions-transfer-session', url: 'https://app.devin.ai/sessions/regions-transfer-session' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 211 });
});

function freshBillPayService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/regions'); });
  return service;
}

describe('Regions Bank dual on-call experience', () => {
  test('serves the shimmed page on the skin, anonymous and friendly URLs', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/regions-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Regions Bank — Online Banking</title>');
      expect(html).toContain('NOT ACTUALLY A REGIONS BANK SITE');
      expect(html).toContain('const oncallApiPath = "/api/oncall/regions/transfers"');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('Pay scheduled bills');
      expect(html).not.toContain('← All Demos');
      expect(html).not.toContain('&larr; All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        expect(() => new vm.Script(script[1])).not.toThrow();
      }
    }
  });

  test('keeps the original Regions Bank event-driven page and accounts unchanged', async () => {
    const html = await (await fetch(`${baseUrl}/4da81799`)).text();
    expect(html).toContain("var ENDPOINT = '/api/4da81799/transfer'");
    expect(html).not.toContain('id="release-batch"');
    const response = await fetch(`${baseUrl}/api/4da81799/accounts`);
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toHaveLength(3);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('separates the transfer shim from the dedicated batch-outage endpoint', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5e57909d.html'), 'utf8');
    expect(html).toContain("var ENDPOINT = '/api/banking/transfer'");
    expect(html).toContain(`fetch('${API}'`);
    expect(html).toContain("accountTier: 'standard'");
    expect(html).toContain('payload.receipt');
    expect(html).toContain('c.receiptId');
    expect(html).not.toMatch(/payload\.confirmation|c\.settlement|humza\.rabbani|cognition\.ai/);
    expect(html).toContain('incident.status === \'declared\'');
  });

  test('a distinct cash-transfer alert immediately starts an investigation and replies with its session link, without declaring an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('regions', { skin, runRef: 'regions-transfer-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][2]).toContain('Regions Bank');
    expect(postMessage.mock.calls[0][2]).not.toContain('Apex');
    expect(postMessage.mock.calls[0][2]).toContain('regions-cash-transfer-api');
    expect(postMessage.mock.calls[0][2]).toContain('POST /api/oncall/regions/transfers');
    expect(postMessage.mock.calls[0][2]).not.toContain('POST /api/oncall/banking/transfer');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
    expect(createDevinSession.mock.calls[0][0]).toContain('regions-cash-transfer-api');
    expect(postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0TEST', '1700000000.000100',
      expect.stringContaining(response.sessionUrl), expect.any(Array));
    expect(response.sessionUrl).toBe('https://app.devin.ai/sessions/regions-transfer-session');
  });

  test('a prior United alert cannot claim the Regions Bank investigation, while Regions Bank repeats reuse their own link', async () => {
    await postOncallAlert('banking', { skin: getOncallSkin('ddfc5af1') });
    const first = await postOncallAlert('regions', { skin: getOncallSkin(SLUG) });
    const repeat = await postOncallAlert('regions', { skin: getOncallSkin(SLUG) });
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(first.sessionUrl).toBe('https://app.devin.ai/sessions/regions-transfer-session');
    expect(repeat).toMatchObject({ grouped: true, sessionUrl: first.sessionUrl });
    expect(postThreadReply).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][2]).toContain('POST /api/oncall/banking/transfer');
    expect(postMessage.mock.calls[1][2]).toContain('POST /api/oncall/regions/transfers');
  });

  test('the dedicated transfer endpoint runs the Regions Bank ledger path and returns the original successful receipt shape', async () => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/oncall/regions/transfers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAccount: 'CHK-1234', toAccount: 'SAV-2345', amount: 250 }),
    });
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8500);
    expect((await response.json()).receipt).toMatchObject({
      from: 'CHK-1234', to: 'SAV-2345', amount: 250, fee: '0.00', totalDebit: '250.00',
    });
    expect(tracer.trace.mock.calls.filter(([name]) => name === 'regions.ledger.balance')).toHaveLength(16);
    expect(tracer.trace).toHaveBeenCalledWith('regions.cash_transfer.submit',
      expect.objectContaining({ service: 'regions-cash-transfer-api' }), expect.any(Function));
    expect(postMessage).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  }, 15000);

  test.each([
    {}, { fromAccount: 'constructor', toAccount: 'SAV-2345', amount: 1 },
    { fromAccount: 'CHK-1234', toAccount: 'constructor', amount: 1 },
    { fromAccount: 'CHK-1234', toAccount: 'CHK-1234', amount: 1 },
    { fromAccount: 'CHK-1234', toAccount: 'SAV-2345', amount: 0.001 },
    { fromAccount: 'CHK-1234', toAccount: 'SAV-2345', amount: 5824.46 },
  ])('invalid cash transfer %j is rejected before ledger work', async (body) => {
    const response = await fetch(`${baseUrl}/api/oncall/regions/transfers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_TRANSFER');
    expect(tracer.trace).not.toHaveBeenCalled();
  });

  test('rejects unknown batches without alerts, incidents or failure telemetry', async () => {
    const response = await fetch(baseUrl + API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: 'unknown' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_BATCH');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(incrementMetric).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
  });

  test('batch release returns a real 503, records outage telemetry and declares only a SEV-1 incident', async () => {
    const response = await fetch(baseUrl + API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: 'BILLS-042', devinEmail: 'operator@example.com' }),
    });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe('BILL_PAY_UNAVAILABLE');
    expect(data.batch).toMatchObject({ paymentCount: 3, totalUsd: 2540, status: 'Ready to pay' });
    expect(data.incident).toMatchObject({ status: 'declared', publicId: 211 });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'SEV-1', service: 'regions-billpay-api', triggeredBy: 'operator@example.com',
      title: 'Regions Bank: online bill pay outage',
    }));
    expect(incrementMetric).toHaveBeenCalledWith('regions.billpay.failure', expect.objectContaining({ service: 'regions-billpay-api' }));
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 211, userIds: ['U0BQZBHCNMA'] });
  });

  test('a full transfer-alert quota cannot block a settlement release from the same IP', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.44' };
    for (let count = 0; count < 50; count++) {
      const response = await fetch(`${baseUrl}/api/oncall/trigger/banking`, {
        method: 'POST', headers, body: JSON.stringify({ unique: false, skin: SLUG }),
      });
      expect(response.status).toBe(200);
    }
    const capped = await fetch(`${baseUrl}/api/oncall/trigger/banking`, {
      method: 'POST', headers, body: JSON.stringify({ unique: false, skin: SLUG }),
    });
    expect(capped.status).toBe(429);
    const batch = await fetch(baseUrl + API, {
      method: 'POST', headers, body: JSON.stringify({ batchId: 'BILLS-042' }),
    });
    expect(batch.status).toBe(503);
    expect((await batch.json()).incident.status).toBe('declared');
  });

  test('invalid batches consume no quota, while valid batch mutations still have a separate limit', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.55' };
    const release = (batchId) => fetch(baseUrl + API, { method: 'POST', headers, body: JSON.stringify({ batchId }) });
    for (let count = 0; count < 55; count++) expect((await release('unknown')).status).toBe(400);
    for (let count = 0; count < 50; count++) expect((await release('BILLS-042')).status).toBe(503);
    const capped = await release('BILLS-042');
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await release('unknown')).status).toBe(400);
  });
});

describe('Regions Bank settlement incident lifecycle', () => {
  test('passes a numeric-string Datadog public ID to the asynchronous invitation helper', async () => {
    declareDatadogIncident.mockResolvedValueOnce({ id: 'dd-string-id', publicId: '211' });
    const service = freshBillPayService();
    expect((await service.submitBillPayments({ batchId: 'BILLS-042' })).body.incident).toMatchObject({ status: 'declared', publicId: '211' });
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: '211', userIds: ['U0BQZBHCNMA'] });
  });
  test('deduplicates concurrent and repeated releases for five minutes', async () => {
    const { submitBillPayments } = freshBillPayService();
    const release = () => submitBillPayments({ batchId: 'BILLS-042' });
    const results = await Promise.all([release(), release(), release()]);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.body.incident.runRef)).size).toBe(1);
    expect((await release()).body.incident.reused).toBe(true);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60000 + 1);
    try { await release(); } finally { clock.mockRestore(); }
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });

  test('reports missing Datadog configuration honestly and allows a later retry', async () => {
    const { submitBillPayments } = freshBillPayService();
    declareDatadogIncident.mockResolvedValueOnce(null);
    const result = await submitBillPayments({ batchId: 'BILLS-042' });
    expect(result.statusCode).toBe(503);
    expect(result.body.incident.status).toBe('unavailable');
    expect((await submitBillPayments({ batchId: 'BILLS-042' })).body.incident.status).toBe('declared');
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });

  test('keeps the outage visible if declaration fails and allows a retry', async () => {
    const { submitBillPayments } = freshBillPayService();
    declareDatadogIncident.mockRejectedValueOnce(new Error('Datadog 403'));
    const result = await submitBillPayments({ batchId: 'BILLS-042', devinEmail: { unsafe: true } });
    expect(result.statusCode).toBe(503);
    expect(result.body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/5e57909d' }));
    expect((await submitBillPayments({ batchId: 'BILLS-042' })).body.incident.status).toBe('declared');
  });
});

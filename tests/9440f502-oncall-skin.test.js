/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() }, initSentry: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn() }));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { incrementMetric } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const { getOncallSkin } = require('../config/oncall-skins');
const { postOncallAlert } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const SLUG = '9440f502';
const API = '/api/oncall/statestreet/settlement-batches/release';
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('../app/routes/oncall'));
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
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 211 });
});

function freshSettlementService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/statestreet'); });
  return service;
}

describe('State Street dual on-call experience', () => {
  test('serves the shimmed page on the skin, anonymous and friendly URLs', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/statestreet-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>State Street — Client Banking Portal</title>');
      expect(html).toContain('NOT ACTUALLY A STATE STREET SITE');
      expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('Release settlement batch');
      expect(html).not.toContain('← All Demos');
      expect(html).not.toContain('&larr; All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        expect(() => new vm.Script(script[1])).not.toThrow();
      }
    }
  });

  test('keeps the original State Street event-driven page and accounts unchanged', async () => {
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
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/9440f502.html'), 'utf8');
    expect(html).toContain("var ENDPOINT = '/api/banking/transfer'");
    expect(html).toContain(`fetch('${API}'`);
    expect(html).toContain("accountTier: 'standard'");
    expect(html).toContain('payload.receipt');
    expect(html).toContain('c.receiptId');
    expect(html).not.toMatch(/payload\.confirmation|c\.settlement|humza\.rabbani|cognition\.ai/);
    expect(html).toContain('incident.status === \'declared\'');
  });

  test('the regular slow-transfer alert never declares an incident or bypasses the Slack responder', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('banking', { skin, runRef: 'ss-transfer-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][2]).toContain('State Street');
    expect(postMessage.mock.calls[0][2]).not.toContain('Apex');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
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
  });

  test('batch release returns a real 503, records outage telemetry and declares only a SEV-1 incident', async () => {
    const response = await fetch(baseUrl + API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: 'USD-SET-042', devinEmail: 'operator@example.com' }),
    });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe('SETTLEMENT_GATEWAY_UNAVAILABLE');
    expect(data.batch).toMatchObject({ paymentCount: 28, totalUsd: 1845000, status: 'Awaiting release' });
    expect(data.incident).toMatchObject({ status: 'declared', publicId: 211 });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'SEV-1', service: 'statestreet-settlement-api', triggeredBy: 'operator@example.com',
      title: 'State Street: USD settlement gateway unavailable',
    }));
    expect(incrementMetric).toHaveBeenCalledWith('settlement.batch.failure', expect.objectContaining({ service: 'statestreet-settlement-api' }));
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
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
      method: 'POST', headers, body: JSON.stringify({ batchId: 'USD-SET-042' }),
    });
    expect(batch.status).toBe(503);
    expect((await batch.json()).incident.status).toBe('declared');
  });

  test('invalid batches consume no quota, while valid batch mutations still have a separate limit', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.55' };
    const release = (batchId) => fetch(baseUrl + API, { method: 'POST', headers, body: JSON.stringify({ batchId }) });
    for (let count = 0; count < 55; count++) expect((await release('unknown')).status).toBe(400);
    for (let count = 0; count < 50; count++) expect((await release('USD-SET-042')).status).toBe(503);
    const capped = await release('USD-SET-042');
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await release('unknown')).status).toBe(400);
  });
});

describe('State Street settlement incident lifecycle', () => {
  test('deduplicates concurrent and repeated releases for five minutes', async () => {
    const { releaseSettlementBatch } = freshSettlementService();
    const release = () => releaseSettlementBatch({ batchId: 'USD-SET-042' });
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
    const { releaseSettlementBatch } = freshSettlementService();
    declareDatadogIncident.mockResolvedValueOnce(null);
    const result = await releaseSettlementBatch({ batchId: 'USD-SET-042' });
    expect(result.statusCode).toBe(503);
    expect(result.body.incident.status).toBe('unavailable');
    expect((await releaseSettlementBatch({ batchId: 'USD-SET-042' })).body.incident.status).toBe('declared');
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });

  test('keeps the outage visible if declaration fails and allows a retry', async () => {
    const { releaseSettlementBatch } = freshSettlementService();
    declareDatadogIncident.mockRejectedValueOnce(new Error('Datadog 403'));
    const result = await releaseSettlementBatch({ batchId: 'USD-SET-042', devinEmail: { unsafe: true } });
    expect(result.statusCode).toBe(503);
    expect(result.body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/9440f502' }));
    expect((await releaseSettlementBatch({ batchId: 'USD-SET-042' })).body.incident.status).toBe('declared');
  });
});

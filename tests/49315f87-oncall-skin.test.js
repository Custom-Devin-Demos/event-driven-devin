/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({
  ...jest.requireActual('../app/telemetry/datadog'),
  recordTiming: jest.fn(),
  incrementMetric: jest.fn(),
}));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'test', url: 'https://app.devin.ai/sessions/test' }),
}));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { setTimeout: delay } = require('node:timers/promises');
const logger = require('../app/telemetry/logger');
const { Sentry } = require('../app/telemetry/sentry');
const { recordTiming } = require('../app/telemetry/datadog');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { REFILLS, REFRESH_DEADLINE_MS, STATUS_LOOKUP_MS } = require('../app/services/oncall-verticals/refillqueue');
const { getOncallSkin } = require('../config/oncall-skins');
const { ALERT_SCENARIOS, postOncallAlert } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);
let server;
let baseUrl;
const SLUG = '49315f87';
const API = '/api/oncall/refillqueue';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('../app/routes/oncall'));
  app.use(require('../app/routes/oncall-verticals'));
  server = http.createServer(app).listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});
beforeEach(() => jest.clearAllMocks());

function refresh(body) {
  return fetch(`${baseUrl}${API}/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('Lumistry refill queue latency incident', () => {
  test('serves the same shimmed dashboard at skin, slug and friendly paths', async () => {
    const pages = await Promise.all([`/oncall/c/${SLUG}`, `/${SLUG}`, '/lumistry', '/lumistry-oncall'].map(async (url) => {
      const response = await fetch(`${baseUrl}${url}`);
      expect(response.status).toBe(200);
      return response.text();
    }));
    pages.forEach((html) => expect(html).toBe(pages[0]));
    expect(pages[0]).toContain('<title>Dashboard | Lumistry One</title>');
    expect(pages[0]).toContain('const oncallApiPath = "/api/oncall/refillqueue"');
    expect(pages[0]).toContain('const alertOnStatus = [504]');
    expect(pages[0]).toContain('var skinAlertDestination = "slack"');
    expect(pages[0]).toContain('NOT ACTUALLY A LUMISTRY SITE');
    expect(pages[0]).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('dashboard scripts parse and the refresh action goes through the on-call shim', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app/public/verticals', `${SLUG}.html`), 'utf8');
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new vm.Script(script[1])).not.toThrow();
    }
    expect(html).toContain("fetch('/api/pharmacy-refills/refresh'");
    expect(html).toContain('refillIds: ids');
    expect(html).toContain("devinEmail: localStorage.getItem('devinEmail') || ''");
    expect(html).toContain('performance.now()');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/Humza|Arlene McCoy|Kisten Watson|Courtney Henry|9384022840|3758674638/);
  });

  test('lists eight saved requests without performing upstream reads or paging anyone', async () => {
    const response = await fetch(`${baseUrl}${API}/refills`);
    expect(response.status).toBe(200);
    expect((await response.json()).refills).toEqual(REFILLS);
    expect(REFILLS).toHaveLength(8);
    expect(logger.info).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('full queue reproduces the real 8s deadline, records serial reads, and cancels remaining work', async () => {
    const startedAt = Date.now();
    const response = await refresh({ refillIds: REFILLS.map((row) => row.id) });
    const durationMs = Date.now() - startedAt;
    const body = await response.json();
    expect(response.status).toBe(504);
    expect(body).toMatchObject({ success: false, code: 'REFILL_REFRESH_TIMEOUT' });
    expect(body.refreshId).toMatch(/^RFR-[0-9A-F]{8}$/);
    expect(body.error).toContain('saved queue is unchanged');
    expect(body).not.toHaveProperty('refills');
    expect(durationMs).toBeGreaterThanOrEqual(REFRESH_DEADLINE_MS - 100);
    expect(durationMs).toBeLessThan(REFRESH_DEADLINE_MS + 2000);
    const lookups = logger.info.mock.calls.filter(([message]) => message === 'Pharmacy status lookup completed');
    expect(lookups.length).toBeLessThan(REFILLS.length);
    expect(lookups.map(([, fields]) => fields.refillId)).toEqual(REFILLS.slice(0, lookups.length).map((row) => row.id));
    expect(lookups.every(([, fields]) => fields.durationMs >= STATUS_LOOKUP_MS - 10)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('Pharmacy status lookup interrupted', expect.objectContaining({ refillId: REFILLS[lookups.length].id }));
    expect(recordTiming).toHaveBeenCalledWith('refillqueue.refresh.latency', expect.any(Number), expect.objectContaining({ scope: 'batch' }));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    await delay(STATUS_LOOKUP_MS + 100);
    expect(logger.info.mock.calls.filter(([message]) => message === 'Pharmacy status lookup completed')).toHaveLength(lookups.length);
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('single-refill control succeeds in about a second, keeps the eligibility status, and does not page', async () => {
    const startedAt = Date.now();
    const response = await refresh({ refillIds: [REFILLS[0].id] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, refills: [REFILLS[0]] });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(STATUS_LOOKUP_MS - 20);
    expect(body.durationMs).toBeLessThan(2000);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('preserves selected row order and clinical rejection outcomes', async () => {
    const selected = [REFILLS[2], REFILLS[1]];
    const response = await refresh({ refillIds: selected.map((row) => row.id) });
    expect(response.status).toBe(200);
    expect((await response.json()).refills).toEqual(selected);
    const saved = await (await fetch(`${baseUrl}${API}/refills`)).json();
    expect(saved.refills).toEqual(REFILLS);
  });

  test('invalid selections fail promptly with 400 and emit no incident telemetry', async () => {
    for (const body of [{}, { refillIds: [] }, { refillIds: 'all' }, { refillIds: ['unknown'] },
      { refillIds: [REFILLS[0].id, REFILLS[0].id] }, { refillIds: Array(9).fill(REFILLS[0].id) },
      { refillIds: [null] }, { refillIds: [{ id: REFILLS[0].id }] }]) {
      const response = await refresh(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, code: 'INVALID_REFILLS' });
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(recordTiming).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('registers a private metric-only incident with a safe local investigation directive', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({ company: 'Lumistry', vertical: 'refillqueue', oncallOnly: true, alertDestination: 'slack' });
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.devinSession.promptAppendix).toContain('Do not submit the live page');
    expect(skin.devinSession.promptAppendix).toContain('Do not merge or deploy');
    const scenario = ALERT_SCENARIOS.refillqueue;
    expect(scenario).toMatchObject({ unlisted: true, alertOnStatus: [504], endpoint: `POST ${API}/refresh` });
    expect(JSON.stringify(scenario)).not.toMatch(/TypeError|\.js:|sequential|1100|loadRefillStatuses|fetchPrescriptionStatus/);
  });

  test('posts a latency-shaped alert and starts the existing on-call investigation pipeline using mocks', async () => {
    const skin = getOncallSkin(SLUG);
    await postOncallAlert('refillqueue', { skin, runRef: 'run-lumistry-test' });
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('p95 latency spike — Lumistry refill status refresh (504)');
    expect(text).toContain(`*Endpoint:* POST ${API}/refresh`);
    expect(text).toContain('p95:demo.refillqueue.refresh.latency');
    expect(text).toContain(`/oncall/c/${SLUG}`);
    expect(text + JSON.stringify(blocks)).not.toMatch(/sequential|loadRefillStatuses|fetchPrescriptionStatus|\.js:|TypeError/);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });

  test('keeps Lumistry off the generic on-call hub and unknown slugs return 404', async () => {
    const hub = await (await fetch(`${baseUrl}/oncall`)).text();
    expect(hub).not.toContain('Lumistry');
    expect(hub).not.toContain(SLUG);
    expect((await fetch(`${baseUrl}/oncall/c/unknown-lumistry`)).status).toBe(404);
  });
});

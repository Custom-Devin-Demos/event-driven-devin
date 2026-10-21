/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { Sentry } = require('../app/telemetry/sentry');
const logger = require('../app/telemetry/logger');
const {
  dispatchResponsePlan,
  agenciesFor,
  RESOURCES,
  TASKING_ENDPOINT,
  DISPATCH_DEADLINE_MS,
} = require('../app/services/oncall-verticals/emergencydispatch');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

const SLUG = 'eba2e983';
const INCIDENT = 'INC-26-10-0471';
const DEFAULT_PLAN = ['HU-401', 'ACO-23', 'BF-07', 'BF-12', 'PC-SECTOR-B'];

describe('IndraMind emergency dispatch on-call vertical', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
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

  test('the default response plan confirms agencies one at a time on the sync endpoint and times out at ~9s', async () => {
    const started = Date.now();
    await expect(dispatchResponsePlan({ incidentId: INCIDENT, resources: DEFAULT_PLAN }))
      .rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(DISPATCH_DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(DISPATCH_DEADLINE_MS + 1000);
    expect(TASKING_ENDPOINT).toBe('v1/tasking-sync');
    const taskingLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Agency tasking confirmation')
      .map(([, fields]) => fields);
    expect(taskingLogs.map((f) => f.agency)).toEqual(['forestales-cm', 'miteco-aereos', 'bomberos-cm', 'proteccion-civil', 'summa-112']);
    expect(taskingLogs.every((f) => f.endpoint === 'v1/tasking-sync' && f.deprecatedEndpoint === true)).toBe(true);
    expect(taskingLogs[4].taskingStatus).toBe('timed_out');
    expect(taskingLogs.slice(0, 4).every((f) => !f.taskingStatus)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toEqual({
      route: '/api/oncall/emergencydispatch/dispatch',
      service: 'cop-dispatch-api',
    });
  });

  test('every valid plan confirms with all coordinating agencies, so even a one-resource plan times out', async () => {
    expect(agenciesFor([RESOURCES['BF-07'], RESOURCES['BF-12']]).map((a) => a.id))
      .toEqual(['bomberos-cm', 'forestales-cm', 'miteco-aereos', 'summa-112', 'gc-seprona', 'proteccion-civil']);
    await expect(dispatchResponsePlan({ incidentId: INCIDENT, resources: ['BF-07'], approvedBy: 'Antonio Ruiz' }))
      .rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT' });
  });

  test('invalid plans are a 400 without Sentry', async () => {
    for (const body of [{}, { incidentId: INCIDENT, resources: [] }, { incidentId: INCIDENT, resources: ['NOPE'] }, { incidentId: 'toString', resources: ['BF-07'] }]) {
      const response = await fetch(`${baseUrl}/api/oncall/emergencydispatch/dispatch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, code: 'INVALID_DISPATCH' });
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the dispatch route answers the default plan with a 504 and a dispatch reference', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/emergencydispatch/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve-dispatch', incidentId: INCIDENT, resources: DEFAULT_PLAN }),
    });
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, errorClass: 'GatewayTimeout', code: 'DISPATCH_TIMEOUT' });
    expect(body.dispatchId).toMatch(/^DSP-[0-9A-F]{4}-0471$/);
  });

  test('the skin pages the presenter as On-Call and owns the Devin session, Banamex-style', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({ company: 'IndraMind', vertical: 'emergencydispatch', alertDestination: 'slack', oncallOnly: true });
    expect(skin.paths).toEqual(['/indramind-oncall']);
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    for (const alert of [ALERT_SCENARIOS.emergencydispatch, skin.alertCard]) {
      expect(JSON.stringify(alert)).not.toMatch(/stack trace|TypeError|\.js:|app\/services|tasking-sync/i);
    }
  });

  test('native page posts through the legacy shim path with the presenter identity', () => {
    const skin = getOncallSkin(SLUG);
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', skin.page.file), 'utf8');
    expect(html).toContain(`<title>${skin.page.title}</title>`);
    expect(html).toContain("postJson('/api/cop-dispatch/dispatch'");
    expect(html).toContain("action: 'approve-dispatch'");
    expect(html).toContain("devinEmail: localStorage.getItem('devinEmail') || ''");
    expect(html).toContain("fetch('/api/config')");
    expect(html).not.toMatch(/\/api\/oncall\//);
    expect(ALERT_SCENARIOS.emergencydispatch.triggerWhen).toEqual({ action: 'approve-dispatch' });
  });
});

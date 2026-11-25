jest.mock('@sentry/node', () => ({ captureException: jest.fn(() => 'evt-ms-1') }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: { url: 'https://app.devin.ai/sessions/ms1' } })),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 'devin-ms2', url: 'https://app.devin.ai/sessions/ms2' })),
}));
jest.mock('../app/services/jira', () => ({
  isConfigured: jest.fn(() => true),
  createIssue: jest.fn(() => Promise.resolve({ id: '1', key: 'MBA-1201', url: 'https://cog-gtm.atlassian.net/browse/MBA-1201' })),
  addComment: jest.fn(() => Promise.resolve({ id: '2' })),
}));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { createDevinSession } = require('../app/services/devin-api');
const jira = require('../app/services/jira');
const svc = require('../app/services/verticals/13ba0f05');
const routes = require('../app/routes/verticals/13ba0f05');
const { getCustomerConfig, listAliases } = require('../config/customers');

function request(method, urlPath, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end(payload);
    });
  });
}
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetFleet();
  svc._incidents.length = 0;
  svc._ideaRequests.clear();
});

describe('Mainspring registration and page', () => {
  test('registers slug, aliases and #oncall-alerts routing', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM', slackChannelId: 'C0BNWUGCWBS' });
    expect(listAliases()['mainspring-fleet']).toBe('13ba0f05');
    expect(listAliases()['mainspring-energy']).toBe('13ba0f05');
  });

  test('page has no third-party assets and carries the disclaimer', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/13ba0f05.html'), 'utf8');
    expect(html).toMatch(/Not affiliated with or endorsed by Mainspring Energy/);
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(html).not.toMatch(/innerHTML/);
  });
});

describe('fuel change', () => {
  test('RNG change schedules with a permit check and completes', async () => {
    const res = await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'RNG_BIOGAS' });
    expect(res.status).toBe(200);
    expect(res.body.change).toMatchObject({ site: 'Ashburn DC-07', to: 'Renewable natural gas (biogas)', status: 'Scheduled' });
    expect(res.body.change.permit.headroomPct).toBeGreaterThan(0);
    const fleet = await request('GET', '/api/13ba0f05/fleet');
    expect(fleet.body.sites.find((s) => s.id === 'iad-dc07').fuel).toBe('RNG_BIOGAS');
    expect(fleet.body.changes).toHaveLength(1);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('validates site, fuel and no-op changes', async () => {
    expect((await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'nope', fuelId: 'RNG_BIOGAS' })).status).toBe(400);
    expect((await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'DIESEL' })).status).toBe(400);
    expect((await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'NG_PIPELINE' })).body.code).toBe('NO_CHANGE');
  });

  // Planted demo failure: the hydrogen blend has no air-permit emission factors under its catalog id.
  test('hydrogen blend fails, files Jira on Shahmir and starts a Devin session as the presenter', async () => {
    const res = await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'H2NG_30' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'FUEL_CHANGE_FAILED', errorClass: 'TypeError' });
    expect(res.body.error).toMatch(/Fuel change not applied/);
    await flush(); await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(jira.createIssue).toHaveBeenCalledWith(expect.objectContaining({ assigneeAccountId: expect.stringMatching(/^712020:/), labels: expect.arrayContaining(['mainspring']) }));
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '13ba0f05', devinUserId: 'email|69efcc3741b62dd9be352f7c', devinEmail: 'shahmir.masood@cognition.ai', skipVulnerablePr: true,
    }));
    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toMatch(/MBA-1201/);
    const inc = await request('GET', '/api/13ba0f05/incidents');
    expect(inc.body.incidents[0]).toMatchObject({ jira: { key: 'MBA-1201' }, session: { url: 'https://app.devin.ai/sessions/ms1' } });
    expect(jira.addComment).toHaveBeenCalledWith('MBA-1201', expect.stringContaining('sessions/ms1'));
  });

  test('browser identity wins over the default presenter', async () => {
    await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'sjc-hq', fuelId: 'H2NG_30', devinUserId: 'email|abc', devinEmail: 'a@b.co' });
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'email|abc', devinEmail: 'a@b.co' }));
  });

  test('reports=off keeps the failure but skips Sentry, Jira and Devin', async () => {
    const res = await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'H2NG_30', reports: 'off' });
    expect(res.status).toBe(500);
    await flush();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alert cooldown prevents duplicate sessions until reset', async () => {
    await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'H2NG_30' });
    await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'H2NG_30' });
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    await request('POST', '/api/13ba0f05/reset', {});
    await request('POST', '/api/13ba0f05/fuel-change', { siteId: 'iad-dc07', fuelId: 'H2NG_30' });
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });
});

describe('greenfield ideas', () => {
  test('lists evidence-backed ideas without the internal build spec', async () => {
    const res = await request('GET', '/api/13ba0f05/ideas');
    expect(res.body.ideas).toHaveLength(3);
    for (const idea of res.body.ideas) {
      expect(idea.build).toBeUndefined();
      expect(idea.evidence.length).toBeGreaterThan(0);
      for (const e of idea.evidence) expect(e.url).toMatch(/^https:\/\//);
    }
  });

  test('starts a Devin build session as the presenter and enforces the daily cap', async () => {
    const res = await request('POST', '/api/13ba0f05/ideas', { ideaId: 'jen-copilot' });
    expect(res.body.request).toMatchObject({ state: 'working', sessionUrl: 'https://app.devin.ai/sessions/ms2' });
    const [prompt, opts] = createDevinSession.mock.calls[0];
    expect(prompt).toMatch(/JEN fault copilot/);
    expect(prompt).toMatch(/bridgenext\.com/);
    expect(opts).toMatchObject({ userId: expect.any(String), repos: ['COG-GTM/event-driven-devin'] });
    for (let i = 0; i < 4; i++) await request('POST', '/api/13ba0f05/ideas', { ideaId: 'permit-headroom' });
    const capped = await request('POST', '/api/13ba0f05/ideas', { ideaId: 'islanded-capacity' });
    expect(capped.status).toBe(429);
    expect((await request('POST', '/api/13ba0f05/ideas', { ideaId: 'nope' })).status).toBe(400);
  });
});

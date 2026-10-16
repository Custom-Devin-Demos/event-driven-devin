/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
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
  createDevinSession: jest.fn(),
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { Sentry } = require('../app/telemetry/sentry');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const {
  createEnvironment, createApplication, ENVIRONMENTS, REGIONS, PROVISION_DEADLINE_MS,
} = require('../app/services/oncall-verticals/identity');
const { ALERT_SCENARIOS, postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

const SLUG = 'a9a14d80';
const VALID_ENV = {
  name: 'Partner Identity - EU',
  description: 'B2B partner sign-on',
  licenseType: 'paid',
  useCase: 'customer',
  type: 'SANDBOX',
  services: ['SSO', 'MFA'],
};
const STAGING_ID = 'd7f03b16-8e4c-4a2d-b1f9-3c6e0d8a0003';

describe('identity on-call vertical: environment provisioning', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creating an environment hangs ~9s registering every region, then times out', async () => {
    const started = Date.now();
    await expect(createEnvironment(VALID_ENV)).rejects.toMatchObject({ code: 'PROVISION_TIMEOUT' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PROVISION_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(PROVISION_DEADLINE_MS + 1000);
    expect(PROVISION_DEADLINE_MS).toBe(9000);
    expect(REGIONS).toHaveLength(6);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('adding an application to an existing environment is fast', async () => {
    const started = Date.now();
    const result = await createApplication({ environmentId: STAGING_ID, name: 'Partner Portal', type: 'OIDC_WEB_APP' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.success).toBe(true);
    expect(result.application).toMatchObject({ environmentId: STAGING_ID, name: 'Partner Portal', type: 'OIDC_WEB_APP', enabled: false });
    expect(result.application.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...VALID_ENV, name: '   ' }],
    [{ ...VALID_ENV, name: 'x'.repeat(257) }],
    [{ ...VALID_ENV, name: 'workforce' }],
    [{ ...VALID_ENV, useCase: 'partner' }],
    [{ ...VALID_ENV, type: 'DEV' }],
    [{ ...VALID_ENV, licenseType: undefined }],
    [{ ...VALID_ENV, services: [] }],
    [{ ...VALID_ENV, services: ['MFA'] }],
    [{ ...VALID_ENV, services: ['SSO', 'BILLING'] }],
  ])('rejects invalid environment %# without contacting any region', async (body) => {
    const started = Date.now();
    await expect(createEnvironment(body)).rejects.toMatchObject({ code: 'INVALID_ENVIRONMENT' });
    expect(Date.now() - started).toBeLessThan(200);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    [{ environmentId: 'nope', name: 'App', type: 'SAML' }],
    [{ environmentId: STAGING_ID, name: '', type: 'SAML' }],
    [{ environmentId: STAGING_ID, name: 'App', type: 'LDAP' }],
  ])('rejects invalid application %#', async (body) => {
    await expect(createApplication(body)).rejects.toMatchObject({ code: 'INVALID_APPLICATION' });
  });

  test('only environment creates page on-call; application creates are just rerouted', () => {
    const s = ALERT_SCENARIOS.identity;
    expect(s.apiPath).toBe('/api/identity-console');
    expect(s.oncallApiPath).toBe('/api/oncall/identity');
    expect(s.triggerWhen).toEqual({ action: 'create-environment' });
    expect(s.unlisted).toBe(true);
  });

  test('alert scenario and skin card are metric-shaped and free of code locations', () => {
    const skin = getOncallSkin(SLUG);
    for (const card of [ALERT_SCENARIOS.identity, skin.alertCard]) {
      expect(card.service).toBe('pingone-environment-api');
      expect(card.metricQuery).toMatch(/^p95:demo\.identity\.environment\.create\.latency\{/);
      expect(card.metricQuery).toContain(`service:${card.service}`);
      expect(card.metricQuery).toContain('route:/api/oncall/identity/environments');
      expect(JSON.stringify(card)).not.toMatch(/\.js\b|registerAcrossRegions|REGIONS|serial|PROVISION_TIMEOUT|TypeError/);
    }
  });

  test('the skin is native, Slack-routed, unbranded in identifiers and has no auto session', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.slug).toBe(SLUG);
    expect(skin.company).toBe('Ping Identity');
    expect(skin.vertical).toBe('identity');
    expect(skin.oncallOnly).toBe(true);
    expect(skin.alertDestination).toBe('slack');
    expect(skin.devinSession).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.paths).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A PING IDENTITY SITE — /);
    expect(skin.theme['--surface']).toBe('#FFFFFF');
    expect(ENVIRONMENTS[STAGING_ID]).toBeDefined();
  });

  test('the page posts to the legacy-shaped paths and never calls on-call endpoints directly', () => {
    const skin = getOncallSkin(SLUG);
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', skin.page.file), 'utf8');
    expect(html).toContain(`<title>${skin.page.title}</title>`);
    expect(html).toContain("postJson('/api/identity-console/environments'");
    expect(html).toContain("postJson('/api/identity-console/applications'");
    expect(html).toContain("action: 'create-environment'");
    expect(html).toContain("action: 'create-application'");
    expect(html).toContain('/session-cap-banner.js');
    expect(html).toContain("fetch('/api/config')");
    expect(html).not.toMatch(/\/api\/oncall\//);
    expect(html).not.toMatch(/All Demos/);
    // Seeded ids on the page must exist server-side so Add Application succeeds.
    for (const id of Object.keys(ENVIRONMENTS)) expect(html).toContain(id);
  });

  test('the alert card names the service with the company and links the skin page, with no Devin session', async () => {
    const skin = getOncallSkin(SLUG);
    const result = await postOncallAlert('identity', { skin, runRef: 'run-test' });
    expect(result).toMatchObject({ ok: true, channel: 'C0TEST' });
    expect(createDevinSession).not.toHaveBeenCalled();
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    const card = `${text}\n${JSON.stringify(blocks)}`;
    expect(card).toContain('*Service:* pingone-environment-api (Ping Identity)');
    expect(card).toMatch(/\*Affected page:\* https?:\/\/[^\s"]+\/oncall\/c\/a9a14d80/);
    expect(card).toContain('POST /api/oncall/identity/environments');
    expect(card).not.toMatch(/registerAcrossRegions|serial/i);
  });

  describe('HTTP routes', () => {
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
      server.close(done);
    });

    test('POST /api/oncall/identity/environments returns a customer-facing 504 after ~9s', async () => {
      const started = Date.now();
      const res = await fetch(`${baseUrl}/api/oncall/identity/environments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-environment', ...VALID_ENV }),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(PROVISION_DEADLINE_MS - 50);
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'PROVISION_TIMEOUT', errorClass: 'GatewayTimeout' });
      expect(body.error).toMatch(/could not be created/);
      expect(body.error).not.toMatch(/region|serial|\.js|exceeded/i);
    });

    test('POST /api/oncall/identity/applications is fast; bad input is a 400', async () => {
      const started = Date.now();
      const res = await fetch(`${baseUrl}/api/oncall/identity/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-application', environmentId: STAGING_ID, name: 'Partner Portal', type: 'SAML' }),
      });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.status).toBe(200);
      expect((await res.json()).application.type).toBe('SAML');
      const bad = await fetch(`${baseUrl}/api/oncall/identity/environments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe('INVALID_ENVIRONMENT');
    });
  });
});

jest.mock('@sentry/node', () => ({ captureException: jest.fn(() => 'sentry-event-1') }));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 'devin-test', url: 'https://app.devin.ai/sessions/test' })),
}));
jest.mock('../app/services/slack', () => ({ postAlertToSlack: jest.fn(), postDevinReply: jest.fn() }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');
const { createDevinSession } = require('../app/services/devin-api');
const slack = require('../app/services/slack');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { getCustomerConfig } = require('../config/customers');
const svc = require('../app/services/verticals/fca13efd');

const NOW = new Date('2026-11-20T16:00:00Z');
const signup = (overrides = {}) => ({
  displayName: 'VaultHunter_77', email: 'vaulthunter77@example.com',
  program: 'bl4-vault-of-the-damned', platform: 'steam-deck', region: 'na',
  ageConfirmed: true, ndaAccepted: true, ...overrides,
});
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetDevinCooldown();
  process.env.DEVIN_SERVICE_KEY_FCA13EFD = 'test-key';
});
afterAll(() => { delete process.env.DEVIN_SERVICE_KEY_FCA13EFD; });

describe('Gearbox playtest registration and page', () => {
  test('registers the hex slug only, in API mode, with no aliases', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Gearbox Software — Playtest Sign-up', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(require('../config/customers/fca13efd').aliases).toBeUndefined();
  });

  test('page pre-fills Steam Deck and posts presenter identity', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/fca13efd.html'), 'utf8');
    expect(html).toContain("platform: 'steam-deck'");
    expect(html).toContain("'/api/fca13efd/playtest-signups'");
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(html).toContain(`identity('${key}')`);
    for (const [, file] of html.matchAll(/data-fallback="\/verticals\/(fca13efd-assets\/[^"]+)"/g)) {
      expect(fs.statSync(path.join(__dirname, '../app/public/verticals', file)).size).toBeGreaterThan(500);
    }
  });
});

describe('healthy platforms and validation', () => {
  test.each(['pc-steam', 'pc-epic', 'ps5', 'xbox-series'])('%s signup gets a build drop', async platform => {
    const result = await svc.submitPlaytestSignup({ signup: signup({ platform }) }, NOW);
    expect(result).toMatchObject({ success: true, wave: 'Wave 3', ndaVersion: 'GBX-NDA-2026.2' });
    expect(result.signupId).toMatch(/^GBX-PT-2026-\d{6}$/);
    expect(result.depotBranch).toMatch(/^playtest_/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('rejects an application without the NDA', async () => {
    await expect(svc.submitPlaytestSignup({ signup: signup({ ndaAccepted: false }) }, NOW)).rejects.toMatchObject({ status: 400, code: 'INVALID_PLAYTEST_SIGNUP' });
  });
});

describe('planted Steam Deck failure goes from Sentry straight to Devin', () => {
  test('default signup fails downstream and opens one Devin session, never Slack', async () => {
    const data = { signup: signup(), devinUserId: 'user-presenter', devinOrgId: 'org-presenter' };
    await expect(svc.submitPlaytestSignup(data, NOW)).rejects.toMatchObject({
      name: 'TypeError', status: 500, code: 'PLAYTEST_SIGNUP_FAILED',
      message: expect.stringContaining("reading 'keyWindowHours'"),
    });
    await flush();

    const [, sentryContext] = Sentry.captureException.mock.calls[0];
    expect(sentryContext.tags).toMatchObject({ customer: 'fca13efd', alert_path: 'instant' });
    expect(JSON.stringify(sentryContext.extra)).not.toMatch(/VaultHunter|example\.com/);
    expect(isInstantPathEvent({ tags: [['alert_path', 'instant']] })).toBe(true);

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({ apiKey: 'test-key', userId: 'user-presenter', orgId: 'org-presenter', repos: ['COG-GTM/event-driven-devin'] });
    expect(prompt).toContain(svc.CULPRIT);
    expect(prompt).toContain('sentry-event-1');
    expect(prompt).toContain(svc.REMEDIATION_DIRECTIVE);
    expect(slack.postAlertToSlack).not.toHaveBeenCalled();
    expect(slack.postDevinReply).not.toHaveBeenCalled();
  });

  test('repeat failures inside the cooldown do not open more sessions', async () => {
    for (let i = 0; i < 3; i += 1) await expect(svc.submitPlaytestSignup({ signup: signup() }, NOW)).rejects.toThrow(TypeError);
    await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });
});

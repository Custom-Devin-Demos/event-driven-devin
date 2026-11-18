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
const registration = (overrides = {}) => ({
  hunterName: 'VaultHunter_77', email: 'vaulthunter77@example.com', platform: 'steam', region: 'US', rulesAccepted: true, ...overrides,
});
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetDevinCooldown();
  process.env.DEVIN_SERVICE_KEY_FCA13EFD = 'test-key';
});
afterAll(() => { delete process.env.DEVIN_SERVICE_KEY_FCA13EFD; });

describe('Gearbox 2K studio page registration and page', () => {
  test('registers the hex slug only, in API mode, with no aliases', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Gearbox Entertainment — The Hunt Registration', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(require('../config/customers/fca13efd').aliases).toBeUndefined();
  });

  test('page pre-selects Steam, posts presenter identity and ships every local image', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/fca13efd.html'), 'utf8');
    expect(html).toContain("platform: 'steam'");
    expect(html).toContain("'/api/fca13efd/hunt-registrations'");
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(html).toContain(`identity('${key}')`);
    const files = [...html.matchAll(/\/verticals\/(fca13efd-assets\/[^"')\s]+)/g)].map(m => m[1]);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(fs.statSync(path.join(__dirname, '../app/public/verticals', file)).size).toBeGreaterThan(100);
  });
});

describe('healthy platforms and validation', () => {
  test.each([
    ['epic', 'Team Epic'], ['ps5', 'Team PlayStation'], ['xbox-series', 'Team Xbox'],
  ])('%s registration joins %s with a fundraising page', async (platform, teamName) => {
    const result = await svc.submitHuntRegistration({ registration: registration({ platform }) }, NOW);
    expect(result).toMatchObject({ success: true, teamName, beneficiary: "St. Jude Children's Research Hospital" });
    expect(result.registrationId).toMatch(/^HUNT-2026-\d{6}$/);
    expect(result.personalGoalUsd).toBeGreaterThan(0);
    expect(result.fundraisingPage).toContain(result.registrationId.toLowerCase());
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('rejects a registration without the official rules', async () => {
    await expect(svc.submitHuntRegistration({ registration: registration({ rulesAccepted: false }) }, NOW)).rejects.toMatchObject({ status: 400, code: 'INVALID_HUNT_REGISTRATION' });
  });
});

describe('planted Steam failure goes from Sentry straight to Devin', () => {
  test('default registration fails downstream and opens one Devin session, never Slack', async () => {
    const data = { registration: registration(), devinUserId: 'user-presenter', devinOrgId: 'org-presenter' };
    await expect(svc.submitHuntRegistration(data, NOW)).rejects.toMatchObject({
      name: 'TypeError', status: 500, code: 'HUNT_REGISTRATION_FAILED',
      message: expect.stringContaining("reading 'teamName'"),
    });
    await flush();

    const [, sentryContext] = Sentry.captureException.mock.calls[0];
    expect(sentryContext.tags).toMatchObject({ customer: 'fca13efd', service: 'gearbox-gives-hunt-registration', alert_path: 'instant' });
    expect(sentryContext.extra).toEqual({ registrationId: expect.stringMatching(/^HUNT-2026-/), event: 'the-hunt-nov-2026', platform: 'steam', region: 'US' });
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
    for (let i = 0; i < 3; i += 1) await expect(svc.submitHuntRegistration({ registration: registration() }, NOW)).rejects.toThrow(TypeError);
    await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });
});

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
const order = (overrides = {}) => ({ product: 'ror2-hallowed-concepts', platform: 'steam', region: 'US', ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetDevinCooldown();
  process.env.DEVIN_SERVICE_KEY_FCA13EFD = 'test-key';
});
afterAll(() => { delete process.env.DEVIN_SERVICE_KEY_FCA13EFD; });

describe('Gearbox 2K studio page registration and page', () => {
  test('registers the hex slug only, in API mode, with no aliases', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Gearbox Entertainment — 2K Buy Now', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(require('../config/customers/fca13efd').aliases).toBeUndefined();
  });

  test('page pre-selects Steam, posts presenter identity and ships every local image', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/fca13efd.html'), 'utf8');
    expect(html).toContain("platform: 'steam'");
    expect(html).toContain("'/api/fca13efd/buy-now'");
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(html).toContain(`identity('${key}')`);
    const files = [...html.matchAll(/\/verticals\/(fca13efd-assets\/[^"')\s]+)/g)].map(m => m[1]);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(fs.statSync(path.join(__dirname, '../app/public/verticals', file)).size).toBeGreaterThan(100);
  });
});

describe('healthy platforms and validation', () => {
  test.each([
    ['epic', 'Epic Games'], ['ps5', 'PlayStation'], ['xbox-series', 'Xbox'], ['switch', 'Nintendo'],
  ])('%s routes to the %s store', async (platform, retailerName) => {
    const result = await svc.submitBuyNow({ order: order({ platform }) }, NOW);
    expect(result).toMatchObject({ success: true, retailerName, edition: 'Digital edition', product: 'Risk of Rain 2: Hallowed Concepts' });
    expect(result.orderId).toMatch(/^2K-BN-2026-\d{6}$/);
    expect(new URL(result.redirectUrl).searchParams.get('utm_source')).toBe('2k.com');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('rejects an unknown region', async () => {
    await expect(svc.submitBuyNow({ order: order({ region: 'XX' }) }, NOW)).rejects.toMatchObject({ status: 400, code: 'INVALID_BUY_NOW' });
  });
});

describe('planted Steam failure goes from Sentry straight to Devin', () => {
  test('default BUY NOW fails downstream and opens one Devin session, never Slack', async () => {
    const data = { order: order(), devinUserId: 'user-presenter', devinOrgId: 'org-presenter' };
    await expect(svc.submitBuyNow(data, NOW)).rejects.toMatchObject({
      name: 'TypeError', status: 500, code: 'BUY_NOW_FAILED',
      message: expect.stringContaining("reading 'checkoutBaseUrl'"),
    });
    await flush();

    const [, sentryContext] = Sentry.captureException.mock.calls[0];
    expect(sentryContext.tags).toMatchObject({ customer: 'fca13efd', service: 'gearbox-buy-now', alert_path: 'instant' });
    expect(sentryContext.extra).toEqual({ orderId: expect.stringMatching(/^2K-BN-/), product: 'ror2-hallowed-concepts', platform: 'steam', region: 'US' });
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
    for (let i = 0; i < 3; i += 1) await expect(svc.submitBuyNow({ order: order() }, NOW)).rejects.toThrow(TypeError);
    await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });
});

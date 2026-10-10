/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { searchProviders, getSearchCatalog } = require('../app/services/verticals/a5bf9cf3');

const IDENTITY = { devinUserId: 'clerk-user_demo', devinOrgId: 'org_demo', devinEmail: 'demo@devindemos.com' };

describe('a5bf9cf3 provider search', () => {
  afterEach(() => jest.clearAllMocks());

  test('catalog exposes insurance plans, search terms and providers for the form', () => {
    const catalog = getSearchCatalog();
    expect(catalog.insurancePlans.length).toBeGreaterThan(50);
    expect(catalog.searchTerms.some((term) => term.text === 'Cardiology')).toBe(true);
    expect(catalog.providers.every((provider) => provider.id && provider.label)).toBe(true);
  });

  test('alerts once on the instant path with the hub identity and no hard-coded owner', async () => {
    await expect(searchProviders({ query: 'Cardiology', insurance: 'aetna', zip: '44304', ...IDENTITY })).rejects.toThrow(TypeError);

    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: 'a5bf9cf3', ...IDENTITY });
    expect(alert).not.toHaveProperty('slackMemberIdFallback');
    expect(alert).not.toHaveProperty('slackMemberId');
  });

  test('sentry webhook skips both event and issue payload shapes', () => {
    expect(isInstantPathEvent({ culprit: 'firstAvailable', tags: [['alert_path', 'instant']] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/a5bf9cf3.js \u2014 firstAvailable', tags: [] })).toBe(true);
  });
});

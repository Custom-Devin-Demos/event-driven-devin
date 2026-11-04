/* global describe, expect, test, jest, beforeEach */
jest.mock('../app/services/slack', () => ({
  postAlertToSlack: jest.fn(() => Promise.resolve('1793000000.000100')),
  postBugReportToTriage: jest.fn(() => Promise.resolve('1793000000.000200')),
  postDevinSessionLink: jest.fn(() => Promise.resolve()),
  postIncidentLink: jest.fn(() => Promise.resolve()),
  postMessage: jest.fn(() => Promise.resolve('1793000000.000100')),
  postThreadReply: jest.fn(() => Promise.resolve()),
  lookupSlackUserByEmail: jest.fn(() => Promise.resolve('U0TRIGGER1')),
  buildAlertBlocks: jest.fn(() => []),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 's-cytric', url: 'https://app.devin.ai/sessions/s-cytric' })),
}));
jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true })),
  reserveSession: jest.fn(() => jest.fn()),
}));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn(), withScope: jest.fn((fn) => fn({ setTransactionName() {}, addEventProcessor() {} })) }, initSentry: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn() }));

const { createDevinSession } = require('../app/services/devin-api');
const { createSessionAndAlert } = require('../app/services/devin-session');

const ALERT = {
  customer: '6571dc84',
  service: 'customer-amadeus-cytric',
  issueTitle: 'BookingRetrievalRejected: CYT-TRP-4031',
  issueUrl: 'https://sentry.example/issues/1',
  culprit: 'backend/traveler-verification.js',
  errorType: 'BookingRetrievalRejected',
  errorValue: 'CYT-TRP-4031: airline booking retrieval rejected (TRAVELER_VERIFICATION_REQUIRED)',
  title: '[Amadeus cytric] CYT-TRP-4031 Boarding pass failed: airline API TRAVELER_VERIFICATION_REQUIRED (ios)',
  sessionPlatform: 'linux',
  repos: ['joao-cognition/demo_webapp', 'joao-cognition/demo_android', 'joao-cognition/demo_ios'],
  promptAppendix: 'You are the LEAD Devin.',
  skipVulnerablePr: true,
  tags: [], extra: {}, level: 'error', firstSeen: '', lastSeen: '', count: '', shortId: '', environment: 'prod', triggeredRule: '',
};

beforeEach(() => {
  createDevinSession.mockClear();
  process.env.DEVIN_API_KEY = process.env.DEVIN_API_KEY || 'test-key';
  process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test';
  process.env.SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0TEST';
  delete process.env.ONCALL_MODE;
});

describe('Amadeus cytric lead session', () => {
  test('scopes the lead Devin session to the three demo repos and the Linux platform', async () => {
    const result = await createSessionAndAlert(ALERT);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('You are the LEAD Devin.');
    expect(options).toMatchObject({
      platform: 'linux',
      repos: ['joao-cognition/demo_webapp', 'joao-cognition/demo_android', 'joao-cognition/demo_ios'],
      title: ALERT.title,
    });
    expect(result && result.session).toBeTruthy();
  });
});

/* global describe, expect, test, jest, afterEach, beforeEach, setImmediate */

jest.mock('../app/services/slack', () => ({
  postMessage: jest.fn(() => Promise.resolve('1792090000.000100')),
  postThreadReply: jest.fn(() => Promise.resolve()),
  lookupSlackUserByEmail: jest.fn(() => Promise.resolve('U0TRIGGER1')),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 's-1', url: 'https://app.devin.ai/sessions/s-1' })),
}));
jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(() => Promise.resolve({ id: 'dd-1', publicId: 7 })),
}));
jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true })),
  reserveSession: jest.fn(() => jest.fn()),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));


const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { OWNER } = require('../app/services/verticals/228d0473');

describe('228d0473 enquiry alert routing', () => {
  test('tagless Sentry webhooks are recognised as instant-path', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/228d0473.js — submitEnquiry', tags: [] })).toBe(true);
  });

  test('incident owner is pinned server-side', () => {
    expect(OWNER).toEqual({
      slackMemberId: 'U08S7AVJ478',
      devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
      devinOrgId: 'org-3d7ae9a506414a189c9a81472e85b5b9',
    });
    expect(Object.isFrozen(OWNER)).toBe(true);
  });
});

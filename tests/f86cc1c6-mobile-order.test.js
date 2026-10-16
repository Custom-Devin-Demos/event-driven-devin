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

const slack = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { Sentry } = require('../app/telemetry/sentry');
const { submitMobileOrder, getMenu } = require('../app/services/verticals/f86cc1c6');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'guest@mde.example',
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID'];
const savedEnv = {};

beforeEach(() => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0BNWUGCWBS';
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  jest.clearAllMocks();
});

const DEFAULT_BAG = [{ id: 'cr1', qty: 1 }, { id: 'cr9', qty: 1 }, { id: 'cr20', qty: 1 }];

describe('My Disney Experience Mobile Order', () => {
  test('menu exposes the holiday category at Cosmic Ray\'s', () => {
    const ids = getMenu('cosmic-rays').categories.map((c) => c.id);
    expect(ids).toContain('holiday-seasonal');
  });

  test('a bag without holiday items submits without alerting', async () => {
    const result = await submitMobileOrder({ restaurantId: 'cosmic-rays', items: [{ id: 'cr1', qty: 2 }, { id: 'cr9', qty: 1 }], ...IDENTITY });
    expect(result.success).toBe(true);
    expect(result.orderNumber).toMatch(/^MO-\d{5}$/);
    expect(result.readyInMinutes).toBe(9);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('other restaurants submit', async () => {
    const result = await submitMobileOrder({ restaurantId: 'pecos-bill', items: [{ id: 'pb1', qty: 1 }], ...IDENTITY });
    expect(result.success).toBe(true);
  });

  test('the pre-filled bag fails, captures once and raises the On-Call alert', async () => {
    await expect(submitMobileOrder({ restaurantId: 'cosmic-rays', items: DEFAULT_BAG, ...IDENTITY }))
      .rejects.toThrow("Cannot read properties of undefined (reading 'prepMinutes')");
    await flush(); await flush(); await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = Sentry.captureException.mock.calls[0];
    expect(ctx.tags.alert_path).toBe('instant');
    expect(JSON.stringify(ctx.extra)).not.toContain('@');
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid input with 400s', async () => {
    await expect(submitMobileOrder({ restaurantId: 'cosmic-rays', items: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(submitMobileOrder({ restaurantId: 'cosmic-rays', items: [{ id: 'pb1', qty: 1 }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(submitMobileOrder({ restaurantId: 'cosmic-rays', items: [{ id: 'cr1', qty: 99 }] })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('tagless Sentry webhooks are recognised as instant-path', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/f86cc1c6.js — estimateReadyWindow', tags: [] })).toBe(true);
  });
});

describe('Walt Disney World resort booking', () => {
  const { bookResortStay } = require('../app/services/verticals/f86cc1c6');

  test.each([['grand-floridian', 'gf-garden'], ['pop-century', 'pc-std'], ['riviera', 'rv-deluxe']])('books %s', async (resortId, roomId) => {
    const result = await bookResortStay({ resortId, roomId, checkIn: '2027-03-11', checkOut: '2027-03-15', adults: 2, children: 2 });
    expect(result.success).toBe(true);
    expect(result.nights).toBe(4);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the pre-filled Lakeshore Lodge stay fails and raises the On-Call alert', async () => {
    await expect(bookResortStay({ ...IDENTITY })).rejects.toThrow("Cannot read properties of undefined (reading 'depositNights')");
    await flush(); await flush(); await flush();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.service).toBe('customer-f86cc1c6-resort-booking');
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });

  test('rejects an oversized party', async () => {
    await expect(bookResortStay({ resortId: 'pop-century', roomId: 'pc-std', adults: 4, children: 2 })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('input validation', () => {
  const { bookResortStay } = require('../app/services/verticals/f86cc1c6');
  test('rejects impossible dates, fractional parties and fractional quantities', async () => {
    await expect(bookResortStay({ resortId: 'pop-century', checkIn: '2027-02-30', checkOut: '2027-03-04' })).rejects.toMatchObject({ code: 'INVALID_DATES' });
    await expect(bookResortStay({ resortId: 'pop-century', adults: 2.5, children: 0 })).rejects.toMatchObject({ code: 'INVALID_PARTY' });
    await expect(submitMobileOrder({ restaurantId: 'cosmic-rays', items: [{ id: 'cr1', qty: 1.9 }] })).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
  });
});

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { processTransfer } = require('../app/services/verticals/bac');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

describe('BAC Credomatic Banca en Linea transfer (bac)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('transfer fails with a TypeError and raises an alert', async () => {
    await expect(processTransfer({
      fromAccount: 'CR-901-4417',
      toAccount: 'CR-901-2205',
      amount: 500,
      accountTier: 'premium',
    })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('bac');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('processTransfer');
    expect(alert.promptAppendix).toContain('/bac');
  });

  test('the demo identity email drives on-call resolution and session ownership', async () => {
    await expect(processTransfer({
      fromAccount: 'CR-901-4417',
      toAccount: 'CR-901-2205',
      amount: 500,
      accountTier: 'premium',
      devinEmail: 'mariana@devindemos.com',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
    })).rejects.toThrow(TypeError);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.devinEmail).toBe('mariana@devindemos.com');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    // No hard-coded owner: the email lookup owns the On-Call field.
    expect(alert.slackMemberId).toBeUndefined();
  });

  test('the Sentry webhook treats BAC events as already alerted', () => {
    // Event-shaped payload: carries the instant tag.
    expect(isInstantPathEvent({
      tags: [['alert_path', 'instant'], ['service', 'bac-banca-en-linea']],
      culprit: '',
    })).toBe(true);

    // Issue-shaped payload: no tags, matched on the module path.
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/bac.js — processTransfer',
    })).toBe(true);

    // A callback frame must not be mistaken for the bac module.
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/other.js — handleCallback',
    })).toBe(false);
  });
});

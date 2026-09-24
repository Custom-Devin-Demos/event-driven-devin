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
const { processTransfer, COMMISSION_SCHEDULES } = require('../app/services/verticals/banamex');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

describe('Banamex Banca en Linea traspaso (banamex)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the prioritario tier completes without a commission and raises no alert', async () => {
    const result = await processTransfer({
      fromAccount: 'BMX-5729814',
      toAccount: 'BMX-5731042',
      amount: 1500,
      accountTier: 'prioritario',
    });

    expect(result.success).toBe(true);
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('1500.00');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the default tier is prioritario when the request omits one', async () => {
    const result = await processTransfer({
      fromAccount: 'BMX-5729814',
      toAccount: 'BMX-5731042',
      amount: 1500,
    });

    expect(result.success).toBe(true);
    expect(result.receipt.fee).toBe('0.00');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every tier offered by the traspaso form has a commission schedule', () => {
    ['prioritario', 'oro', 'clasica'].forEach((tier) => {
      expect(COMMISSION_SCHEDULES[tier]).toEqual({
        rate: expect.any(Number),
        flat: expect.any(Number),
      });
    });
  });

  test('an unenrolled tier fails with a named schedule error, not a TypeError', async () => {
    await expect(processTransfer({
      fromAccount: 'BMX-5729814',
      toAccount: 'BMX-5731042',
      amount: 1500,
      accountTier: 'platino',
    })).rejects.toMatchObject({
      name: 'CommissionScheduleError',
      code: 'COMMISSION_SCHEDULE_NOT_FOUND',
      message: expect.stringContaining('platino'),
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('banamex');
    expect(alert.errorType).toBe('CommissionScheduleError');
    expect(alert.culprit).toContain('processTransfer');
    expect(alert.promptAppendix).toContain('/banamex');
  });

  test('tiers with a commission schedule complete and return a receipt', async () => {
    const result = await processTransfer({
      fromAccount: 'BMX-5731042',
      toAccount: 'BMX-4071',
      amount: 1500,
      accountTier: 'oro',
    });

    expect(result.success).toBe(true);
    expect(result.receipt.fee).toBe('8.00');
    expect(result.receipt.totalDebit).toBe('1508.00');
    expect(result.receipt.receiptId).toBe(`BMX-${result.transferId}`);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the demo identity email drives on-call resolution and session ownership', async () => {
    await expect(processTransfer({
      fromAccount: 'BMX-5729814',
      toAccount: 'BMX-5731042',
      amount: 1500,
      accountTier: 'platino',
      devinEmail: 'mariana@devindemos.com',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
    })).rejects.toThrow('platino');

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.devinEmail).toBe('mariana@devindemos.com');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    // No hard-coded owner: the email lookup owns the On-Call field.
    expect(alert.slackMemberId).toBeUndefined();
  });

  test('the Sentry webhook treats Banamex events as already alerted', () => {
    expect(isInstantPathEvent({
      tags: [['alert_path', 'instant'], ['service', 'banamex-banca-en-linea']],
      culprit: '',
    })).toBe(true);

    // Issue-shaped payload: no tags, matched on the module path.
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/banamex.js — processTransfer',
    })).toBe(true);
  });
});

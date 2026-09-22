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
const {
  submitTransfer,
  ACCOUNTS,
  DEFAULT_FROM_ACCOUNT,
  DEFAULT_TO_ACCOUNT,
} = require('../app/services/verticals/4da81799');

describe('State Street client banking portal transfer (4da81799)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('default Liquidity Plus transfer fails with a TypeError and raises an alert', async () => {
    await expect(submitTransfer({
      fromAccount: DEFAULT_FROM_ACCOUNT,
      toAccount: DEFAULT_TO_ACCOUNT,
      amount: 250000,
    })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('4da81799');
    expect(alert.slackMemberId).toBe('U0BQZBHCNMA');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('buildSettlementInstruction');
  });

  test('accounts on a registered cash program settle successfully', async () => {
    const result = await submitTransfer({
      fromAccount: 'OPR-1234',
      toAccount: 'CUS-2345',
      amount: 100000,
    });

    expect(result.success).toBe(true);
    expect(result.confirmation.settlement.railName).toBe('Fedwire');
    expect(result.confirmation.settlement.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('validation failures return 400s without raising an alert', async () => {
    const cases = [
      { fromAccount: 'OPR-1234', toAccount: 'OPR-1234', amount: 100, code: 'SAME_ACCOUNT' },
      { fromAccount: 'OPR-1234', toAccount: 'CUS-2345', amount: 0, code: 'INVALID_AMOUNT' },
      {
        fromAccount: 'OPR-1234',
        toAccount: 'CUS-2345',
        amount: ACCOUNTS['OPR-1234'].availableBalance + 1,
        code: 'INSUFFICIENT_FUNDS',
      },
      { fromAccount: 'NOPE-0000', toAccount: 'CUS-2345', amount: 100, code: 'ACCOUNT_NOT_FOUND' },
    ];

    for (const testCase of cases) {
      await expect(submitTransfer(testCase)).rejects.toMatchObject({
        name: 'ValidationError',
        statusCode: 400,
        code: testCase.code,
      });
    }

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

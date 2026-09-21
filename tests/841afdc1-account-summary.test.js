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
  processAccountSummary,
  ACCOUNTS,
  FINANCE_PRODUCTS,
} = require('../app/services/verticals/841afdc1');

const LEASE = ACCOUNTS.find((a) => a.productType === 'red_carpet_lease');
const INSTALLMENT = ACCOUNTS.find((a) => a.productType === 'retail_installment');

describe('Account Manager summary (841afdc1)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('red_carpet_lease (no escrow) summary succeeds with zero escrow', async () => {
    expect(FINANCE_PRODUCTS.red_carpet_lease.escrowManaged).toBe(false);

    const summary = await processAccountSummary({
      accountId: LEASE.id,
      productType: LEASE.productType,
    });

    expect(summary.accountId).toBe(LEASE.id);
    expect(summary.monthlyEscrow).toBe(0);
    expect(summary.escrowManaged).toBe(false);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly,
      2,
    );
    expect(Number.isFinite(summary.monthlyTotal)).toBe(true);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('default request (no accountId) resolves to the lease account and succeeds', async () => {
    const summary = await processAccountSummary({ accountId: 'LSE-2208314' });
    expect(summary.monthlyEscrow).toBe(0);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('retail_installment (escrow managed) summary includes escrow in monthly total', async () => {
    const summary = await processAccountSummary({
      accountId: INSTALLMENT.id,
      productType: INSTALLMENT.productType,
    });

    expect(summary.escrowManaged).toBe(true);
    expect(summary.monthlyEscrow).toBeGreaterThan(0);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly + summary.monthlyEscrow,
      2,
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('unknown accountId falls back to the first account without throwing', async () => {
    const summary = await processAccountSummary({ accountId: 'DOES-NOT-EXIST' });
    expect(summary.accountId).toBe(ACCOUNTS[0].id);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

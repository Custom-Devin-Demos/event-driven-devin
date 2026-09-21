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

  test('red_carpet_lease (non-escrow product) summarizes without throwing', async () => {
    expect(FINANCE_PRODUCTS.red_carpet_lease.escrowManaged).toBe(false);

    const summary = await processAccountSummary({
      accountId: LEASE.id,
      productType: LEASE.productType,
    });

    expect(summary.accountId).toBe(LEASE.id);
    expect(summary.monthlyEscrow).toBe(0);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly,
      2,
    );
    expect(Number.isFinite(summary.monthlyTotal)).toBe(true);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('retail_installment (escrow-managed product) still includes escrow in the total', async () => {
    expect(FINANCE_PRODUCTS.retail_installment.escrowManaged).toBe(true);

    const summary = await processAccountSummary({
      accountId: INSTALLMENT.id,
      productType: INSTALLMENT.productType,
    });

    expect(summary.monthlyEscrow).toBeGreaterThan(0);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly + summary.monthlyEscrow,
      2,
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('missing accountId falls back to the default account and succeeds', async () => {
    const summary = await processAccountSummary({});

    expect(summary.accountId).toBe(ACCOUNTS[0].id);
    expect(Number.isFinite(summary.monthlyTotal)).toBe(true);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('unknown accountId resolves to the default account rather than throwing', async () => {
    const summary = await processAccountSummary({ accountId: 'DOES-NOT-EXIST' });

    expect(summary.accountId).toBe(ACCOUNTS[0].id);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

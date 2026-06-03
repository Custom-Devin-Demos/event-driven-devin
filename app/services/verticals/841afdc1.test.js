// uuid v13 ships as pure ESM, which Jest's default (CJS) transform can't load.
// The id value is irrelevant to these assertions, so stub it.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const { processAccountSummary, FINANCE_PRODUCTS } = require('./841afdc1');

describe('processAccountSummary — escrow handling (NODE-EXPRESS-20)', () => {
  // Reproduces the original failure: red_carpet_lease is not escrow-managed, so
  // the payment plan has no `escrow` object. Previously summarizeAccount read
  // `plan.escrow.monthlyEscrow` unconditionally and threw
  // "TypeError: Cannot read properties of undefined (reading 'monthlyEscrow')".
  test('red_carpet_lease (no escrow) resolves with monthlyEscrow 0', async () => {
    expect(FINANCE_PRODUCTS.red_carpet_lease.escrowManaged).toBe(false);

    const summary = await processAccountSummary({
      accountId: 'LSE-2208314',
      productType: 'red_carpet_lease',
    });

    expect(summary.monthlyEscrow).toBe(0);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly,
      2,
    );
  });

  // Escrow-managed product still includes escrow in the summary and total.
  test('retail_installment (escrow managed) includes escrow in the total', async () => {
    expect(FINANCE_PRODUCTS.retail_installment.escrowManaged).toBe(true);

    const summary = await processAccountSummary({
      accountId: 'RAC-4471920',
      productType: 'retail_installment',
    });

    expect(summary.monthlyEscrow).toBeGreaterThan(0);
    expect(summary.monthlyTotal).toBeCloseTo(
      summary.monthlyPrincipalInterest + summary.programsMonthly + summary.monthlyEscrow,
      2,
    );
  });
});

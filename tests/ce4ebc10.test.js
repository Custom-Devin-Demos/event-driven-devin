/* global describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const {
  publishPricing,
  resolveRevenueTreatment,
  ACCOUNTS,
  REV_REC_TREATMENTS,
} = require('../app/services/verticals/ce4ebc10');

const DEFAULT_DATA = {
  accountId: 'acct-4471',
  ratePerToken: 0.002,
  usageTokens: 1240000,
  committedSpend: 50000,
};

describe('Zuora AI usage pricing service (ce4ebc10)', () => {
  test('publishes usage pricing with the expected invoice amount', async () => {
    const result = await publishPricing({ ...DEFAULT_DATA, pricingModel: 'usage' });

    expect(result.success).toBe(true);
    expect(result.invoice.amount).toBe(2480);
    expect(result.invoice.invoiceNumber).toBe('INV-2048');
    expect(result.revenue.schedule).toHaveLength(5);
    expect(result.revenue.schedule.reduce((sum, bucket) => sum + bucket.amount, 0)).toBe(2480);
  });

  test('publishes flat pricing with the expected invoice amount', async () => {
    const result = await publishPricing({ ...DEFAULT_DATA, pricingModel: 'flat' });

    expect(result.success).toBe(true);
    expect(result.invoice.amount).toBe(2480);
    expect(result.revenue.recognitionMethod).toBe('straight_line');
  });

  test('hybrid pricing throws when its unregistered treatment is validated', async () => {
    await expect(publishPricing({ ...DEFAULT_DATA, pricingModel: 'hybrid' }))
      .rejects.toThrow(/recognitionMethod/);
  });

  test('resolves hybrid drawdown to a code absent from the treatment registry', () => {
    const treatment = resolveRevenueTreatment('hybrid', ACCOUNTS['acct-4471']);

    expect(treatment).toBe('hybrid_drawdown');
    expect(Object.hasOwn(REV_REC_TREATMENTS, treatment)).toBe(false);
  });
});

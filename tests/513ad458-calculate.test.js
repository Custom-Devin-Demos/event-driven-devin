/* global beforeEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric, recordTiming } = require('../app/telemetry/datadog');
const {
  calculateTax,
  computeJurisdictionTax,
  JURISDICTIONS,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/513ad458');

const DEFAULT_TAX_DATA = {
  companyCode: 'ACME-US-01',
  customerCode: 'CUST-100482',
  jurisdiction: 'PA',
  productClass: 'SAAS',
  amount: 125000,
  quantity: 1,
  devinUserId: 'test-user',
  devinOrgId: 'test-org',
  devinEmail: 'test@example.com',
};

describe('Vertex Cloud tax calculation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['ZZ', 'constructor'])(
    'calculateTax rejects invalid jurisdiction %s before telemetry or alerting',
    async (jurisdiction) => {
      await expect(calculateTax({ ...DEFAULT_TAX_DATA, jurisdiction }))
        .rejects.toMatchObject({
          name: 'ValidationError',
          code: 'INVALID_JURISDICTION',
          status: 400,
        });

      expect(createSessionAndAlert).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(incrementMetric).not.toHaveBeenCalled();
      expect(recordTiming).not.toHaveBeenCalled();
    },
  );

  test('calculateTax rejects an invalid product class before alerting', async () => {
    await expect(calculateTax({ ...DEFAULT_TAX_DATA, productClass: 'UNKNOWN' }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_PRODUCT_CLASS',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(incrementMetric).not.toHaveBeenCalled();
    expect(recordTiming).not.toHaveBeenCalled();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '125000', 1e307])(
    'calculateTax rejects invalid amount %s before alerting',
    async (amount) => {
      await expect(calculateTax({ ...DEFAULT_TAX_DATA, productClass: 'TPP', amount }))
        .rejects.toMatchObject({
          name: 'ValidationError',
          code: 'INVALID_AMOUNT',
          status: 400,
        });

      expect(createSessionAndAlert).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(incrementMetric).not.toHaveBeenCalled();
      expect(recordTiming).not.toHaveBeenCalled();
    },
  );

  test.each([0, 1.5, -1, 1e7])('calculateTax rejects invalid quantity %s', async (quantity) => {
    await expect(calculateTax({ ...DEFAULT_TAX_DATA, productClass: 'TPP', quantity }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_QUANTITY',
        status: 400,
      });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('default PA SaaS calculation hits the planted lookup error and triggers a Devin session', async () => {
    await expect(calculateTax(DEFAULT_TAX_DATA))
      .rejects.toMatchObject({
        name: 'TypeError',
        message: expect.stringMatching(/reading 'taxable'/),
      });

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: '513ad458',
        service: 'vertex-tax-engine',
        promptAppendix: expect.stringContaining('513ad458'),
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
    expect(incrementMetric).toHaveBeenCalledWith(
      'tax.calculation.failure',
      expect.objectContaining({ route: '/api/513ad458/calculate' }),
    );
    expect(recordTiming).toHaveBeenCalledWith(
      'tax.calculation.latency',
      expect.any(Number),
      expect.objectContaining({ error: 'true' }),
    );
    expect(REMEDIATION_DIRECTIVE).toContain('Open a pull request against `main`');
  });

  test('TPP in Pennsylvania applies the combined 8% rate', async () => {
    const result = await calculateTax({ ...DEFAULT_TAX_DATA, productClass: 'TPP' });

    expect(result.taxable).toBe(true);
    expect(result.taxRate).toBe(0.08);
    expect(result.taxAmount).toBe(10000);
    expect(result.total).toBe(135000);
    expect(result.currency).toBe('USD');
    expect(result.lineItems).toEqual([
      { authority: 'Pennsylvania', rate: 0.06, tax: 7500 },
      { authority: 'Philadelphia County', rate: 0.02, tax: 2500 },
    ]);
  });

  test('professional services in Pennsylvania are exempt', async () => {
    const result = await calculateTax({ ...DEFAULT_TAX_DATA, productClass: 'PROF_SVC' });

    expect(result.taxable).toBe(false);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(125000);
  });

  test('German TPP calculation applies 19% VAT in EUR', async () => {
    const result = await calculateTax({
      ...DEFAULT_TAX_DATA,
      jurisdiction: 'DE',
      productClass: 'TPP',
    });

    expect(result.taxRate).toBe(0.19);
    expect(result.taxAmount).toBe(23750);
    expect(result.currency).toBe('EUR');
    expect(result.total).toBe(148750);
  });

  test('computeJurisdictionTax returns per-authority rounded tax lines and totals', () => {
    const result = computeJurisdictionTax(100, JURISDICTIONS.NY, true);

    expect(result.taxRate).toBe(0.08875);
    expect(result.lineItems).toEqual([
      { authority: 'NY State', rate: 0.04, tax: 4 },
      { authority: 'NYC', rate: 0.045, tax: 4.5 },
      { authority: 'MCTD', rate: 0.00375, tax: 0.38 },
    ]);
    expect(result.taxAmount).toBe(8.88);
  });
});

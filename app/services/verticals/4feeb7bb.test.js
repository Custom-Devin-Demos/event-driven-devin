jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../../telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../../telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));

const { runInquiry, BRANCHES, MORTGAGE_PRODUCTS } = require('./4feeb7bb');

describe('4feeb7bb banking vertical — mortgage rate inquiry', () => {
  describe('runInquiry', () => {
    it('should return mortgage rates for the stockholm region without errors', async () => {
      const result = await runInquiry({
        region: 'stockholm',
        loanType: 'all',
        principal: 500000,
      });

      expect(result).toBeDefined();
      expect(result.branch).toBe('Stockholm Branch');
      expect(result.branchCode).toBe('stockholm');
      expect(result.products).toBeInstanceOf(Array);
      expect(result.products.length).toBeGreaterThan(0);
      expect(result.inquiryId).toBe('test-uuid-1234');

      result.products.forEach((product) => {
        expect(product.adjustedRate).toBeGreaterThan(0);
        expect(typeof product.estimatedMonthly).toBe('number');
        expect(product.estimatedMonthly).toBeGreaterThan(0);
      });
    });

    it('should correctly compute adjustedRate using riskPremium for stockholm', async () => {
      const result = await runInquiry({
        region: 'stockholm',
        loanType: 'fixed',
        principal: 300000,
      });

      const fixedProducts = MORTGAGE_PRODUCTS.filter((p) => p.type === 'fixed');
      expect(result.products.length).toBe(fixedProducts.length);

      result.products.forEach((product) => {
        const source = fixedProducts.find((p) => p.id === product.productId);
        const expectedRate = Math.round(source.baseRate * 0.85 * 1000) / 1000;
        expect(product.adjustedRate).toBe(expectedRate);
      });
    });

    it('should handle all supported regions without errors', async () => {
      const regions = BRANCHES.map((b) => b.code);
      for (const region of regions) {
        const result = await runInquiry({
          region,
          loanType: 'all',
          principal: 400000,
        });

        expect(result).toBeDefined();
        expect(result.branchCode).toBe(region);
        expect(result.products.length).toBe(MORTGAGE_PRODUCTS.length);
        result.products.forEach((p) => {
          expect(p.adjustedRate).toBeGreaterThan(0);
          expect(typeof p.adjustedRate).toBe('number');
        });
      }
    });

    it('should filter products by loanType', async () => {
      const result = await runInquiry({
        region: 'oslo',
        loanType: 'adjustable',
        principal: 600000,
      });

      result.products.forEach((product) => {
        expect(product.type).toBe('adjustable');
      });
    });

    it('should return all products when loanType is invalid', async () => {
      const result = await runInquiry({
        region: 'copenhagen',
        loanType: 'nonexistent',
        principal: 250000,
      });

      expect(result.products.length).toBe(MORTGAGE_PRODUCTS.length);
    });

    it('should include recommendations when rates are not competitive', async () => {
      const result = await runInquiry({
        region: 'reykjavik',
        loanType: 'jumbo',
        principal: 1000000,
      });

      expect(result).toBeDefined();
      expect(result.bestAvailableRate).toBeGreaterThan(0);
    });
  });
});

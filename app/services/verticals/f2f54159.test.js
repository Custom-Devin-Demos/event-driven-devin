/* eslint-disable no-unused-vars */

// Mock uuid (ESM package) before requiring the module
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock telemetry and external dependencies before requiring the module
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../../telemetry/datadog', () => ({
  initDatadog: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../../telemetry/sentry', () => ({
  initSentry: jest.fn(),
  Sentry: {
    captureException: jest.fn(),
  },
}));

jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processPreorder, PRODUCTS, WAREHOUSES, SHIPPING_METHODS, PRICING_RULES } = require('./f2f54159');

describe('f2f54159 preorder service', () => {
  describe('processPreorder', () => {
    it('should successfully process a preorder with a valid region and SKU', async () => {
      const result = await processPreorder({
        sku: 'ML-001',
        quantity: 2,
        region: 'northeast',
        shippingPreference: 'standard',
        productLine: 'marvel-legends',
        email: 'test@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.orderId).toBeDefined();
      expect(result.product.sku).toBe('ML-001');
      expect(result.product.name).toBe('Spider-Man Retro Collection');
      expect(result.pricing.quantity).toBe(2);
      expect(result.inventory.warehouse).toBe('Providence Distribution Center');
      expect(result.shipping.method).toBe('Standard Ground');
      expect(result.status).toBe('pre-order-confirmed');
    });

    it('should handle a region with no warehouse mapping gracefully', async () => {
      // This reproduces the original bug: an unknown region yields
      // inventory.warehouse === undefined, which previously caused
      // TypeError: Cannot read properties of undefined (reading 'name')
      const result = await processPreorder({
        sku: 'ML-001',
        quantity: 1,
        region: 'unknown-region',
        shippingPreference: 'standard',
        productLine: 'marvel-legends',
        email: 'test@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.inventory.warehouse).toBe('Unassigned');
    });

    it('should handle undefined region gracefully', async () => {
      const result = await processPreorder({
        sku: 'ML-003',
        quantity: 1,
        region: undefined,
        shippingPreference: 'standard',
        productLine: 'marvel-legends',
      });

      expect(result.success).toBe(true);
      expect(result.inventory.warehouse).toBe('Unassigned');
    });

    it('should handle null region gracefully', async () => {
      const result = await processPreorder({
        sku: 'ML-003',
        quantity: 1,
        region: null,
        shippingPreference: 'standard',
        productLine: 'marvel-legends',
      });

      expect(result.success).toBe(true);
      expect(result.inventory.warehouse).toBe('Unassigned');
    });

    it('should throw an error for unknown product SKU', async () => {
      await expect(processPreorder({
        sku: 'UNKNOWN-SKU',
        quantity: 1,
        region: 'northeast',
        shippingPreference: 'standard',
      })).rejects.toThrow('Unknown product SKU: UNKNOWN-SKU');
    });

    it('should calculate pricing correctly for deluxe edition with discount', async () => {
      const result = await processPreorder({
        sku: 'ML-002', // Wolverine Premium Figure, deluxe edition, $34.99
        quantity: 3,
        region: 'southeast',
        shippingPreference: 'express',
        productLine: 'marvel-legends',
      });

      expect(result.success).toBe(true);
      expect(result.pricing.edition).toBe('deluxe');
      // Deluxe has 5% discount: 34.99 * 0.95 = 33.2405 => rounded to 33.24
      expect(result.pricing.unitPrice).toBe(33.24);
      expect(result.pricing.subtotal).toBe(99.72);
      // Deluxe preorder bonus: $2.00 * 3 = $6.00
      expect(result.pricing.preorderSavings).toBe(6.00);
    });

    it('should apply region surcharge for west coast shipping', async () => {
      const result = await processPreorder({
        sku: 'ML-001',
        quantity: 1,
        region: 'west',
        shippingPreference: 'standard',
        productLine: 'marvel-legends',
      });

      expect(result.success).toBe(true);
      // Standard shipping $5.99 + $2.00 west surcharge = $7.99
      expect(result.shipping.cost).toBe(7.99);
    });

    it('should handle all valid regions correctly', async () => {
      const regions = ['northeast', 'southeast', 'midwest', 'west'];
      for (const region of regions) {
        const result = await processPreorder({
          sku: 'ML-001',
          quantity: 1,
          region,
          shippingPreference: 'standard',
        });

        expect(result.success).toBe(true);
        expect(result.inventory.warehouse).toBe(WAREHOUSES[region].name);
      }
    });
  });

  describe('data constants', () => {
    it('should have all expected products in the catalog', () => {
      expect(PRODUCTS).toHaveLength(8);
      const skus = PRODUCTS.map((p) => p.sku);
      expect(skus).toContain('ML-001');
      expect(skus).toContain('ML-008');
    });

    it('should have warehouses for all standard regions', () => {
      expect(WAREHOUSES.northeast).toBeDefined();
      expect(WAREHOUSES.southeast).toBeDefined();
      expect(WAREHOUSES.midwest).toBeDefined();
      expect(WAREHOUSES.west).toBeDefined();
    });

    it('should have all shipping methods defined', () => {
      expect(SHIPPING_METHODS.standard).toBeDefined();
      expect(SHIPPING_METHODS.express).toBeDefined();
      expect(SHIPPING_METHODS.priority).toBeDefined();
    });
  });
});

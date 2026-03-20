// Mock uuid before importing the module under test (ESM compatibility)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock external dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { getStyleRecommendations, STYLE_PROFILES, ROOM_PRODUCTS } = require('./wayfair');

describe('wayfair service', () => {
  describe('getStyleRecommendations', () => {
    it('should return recommendations for a valid style (modern)', async () => {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style: 'modern',
        budget: 1500,
      });

      expect(result.success).toBe(true);
      expect(result.style).toBe('modern');
      expect(result.room).toBe('living-room');
      expect(result.recommendations).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(result.totalFound).toBeGreaterThanOrEqual(0);
      expect(result.processedAt).toBeDefined();
    });

    it('should return recommendations for each valid style', async () => {
      const validStyles = Object.keys(STYLE_PROFILES);

      for (const style of validStyles) {
        const result = await getStyleRecommendations({
          room: 'living-room',
          style,
          budget: 5000,
        });

        expect(result.success).toBe(true);
        expect(result.style).toBe(style);
      }
    });

    it('should throw an error for an invalid style', async () => {
      await expect(
        getStyleRecommendations({
          room: 'living-room',
          style: 'invalid-style',
          budget: 1000,
        })
      ).rejects.toThrow('Unknown style: invalid-style');
    });

    it('should throw for null style', async () => {
      await expect(
        getStyleRecommendations({
          room: 'living-room',
          style: null,
          budget: 1000,
        })
      ).rejects.toThrow('Unknown style: null');
    });

    it('should throw for undefined style', async () => {
      await expect(
        getStyleRecommendations({
          room: 'living-room',
          style: undefined,
          budget: 1000,
        })
      ).rejects.toThrow('Unknown style: undefined');
    });

    it('should throw for empty string style', async () => {
      await expect(
        getStyleRecommendations({
          room: 'living-room',
          style: '',
          budget: 1000,
        })
      ).rejects.toThrow('Unknown style: ');
    });

    it('should filter recommendations by budget', async () => {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style: 'modern',
        budget: 200,
      });

      expect(result.success).toBe(true);
      result.recommendations.forEach((rec) => {
        const priceNum = parseFloat(rec.price.replace('$', ''));
        expect(priceNum).toBeLessThanOrEqual(200);
      });
    });

    it('should return at most 3 recommendations', async () => {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style: 'modern',
        budget: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.recommendations.length).toBeLessThanOrEqual(3);
    });

    it('should include proper fields in each recommendation', async () => {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style: 'modern',
        budget: 5000,
      });

      expect(result.success).toBe(true);
      result.recommendations.forEach((rec) => {
        expect(rec).toHaveProperty('product');
        expect(rec).toHaveProperty('price');
        expect(rec).toHaveProperty('matchScore');
        expect(rec).toHaveProperty('verdict');
        expect(typeof rec.product).toBe('string');
        expect(typeof rec.price).toBe('string');
        expect(typeof rec.matchScore).toBe('number');
      });
    });
  });

  describe('STYLE_PROFILES', () => {
    it('should contain the expected styles', () => {
      expect(Object.keys(STYLE_PROFILES)).toEqual(
        expect.arrayContaining(['modern', 'traditional', 'farmhouse', 'contemporary'])
      );
    });

    it('each profile should have a factor and tags array', () => {
      Object.values(STYLE_PROFILES).forEach((profile) => {
        expect(typeof profile.factor).toBe('number');
        expect(Array.isArray(profile.tags)).toBe(true);
        expect(profile.tags.length).toBeGreaterThan(0);
      });
    });
  });

  describe('ROOM_PRODUCTS', () => {
    it('should have products with required fields', () => {
      ROOM_PRODUCTS.forEach((product) => {
        expect(product).toHaveProperty('sku');
        expect(product).toHaveProperty('name');
        expect(product).toHaveProperty('room');
        expect(product).toHaveProperty('price');
        expect(product).toHaveProperty('rating');
        expect(product).toHaveProperty('tags');
        expect(Array.isArray(product.tags)).toBe(true);
      });
    });
  });
});

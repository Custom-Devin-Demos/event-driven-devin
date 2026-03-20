// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
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

const { getStyleRecommendations, STYLE_PROFILES } = require('./wayfair');

describe('getStyleRecommendations', () => {
  it('should return recommendations for a valid style', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.room).toBe('living-room');
    expect(result.style).toBe('modern');
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.totalFound).toBeGreaterThanOrEqual(result.recommendations.length);
    expect(result.requestId).toBeDefined();
    expect(result.processedAt).toBeDefined();
  });

  it('should handle an unknown style gracefully instead of throwing', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'invalid-style',
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.style).toBe('invalid-style');
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.totalFound).toBeGreaterThanOrEqual(0);
  });

  it('should handle null style by falling back to default', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: null,
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  it('should handle undefined style by falling back to default', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: undefined,
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  it('should handle empty string style by falling back to default', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: '',
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  it('should return recommendations with correct structure', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 5000,
    });

    expect(result.success).toBe(true);
    for (const rec of result.recommendations) {
      expect(rec).toHaveProperty('product');
      expect(rec).toHaveProperty('price');
      expect(rec).toHaveProperty('matchScore');
      expect(rec).toHaveProperty('verdict');
      expect(typeof rec.product).toBe('string');
      expect(typeof rec.price).toBe('string');
      expect(typeof rec.matchScore).toBe('number');
    }
  });

  it('should respect budget constraints', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 200,
    });

    expect(result.success).toBe(true);
    for (const rec of result.recommendations) {
      const price = parseFloat(rec.price.replace('$', ''));
      expect(price).toBeLessThanOrEqual(200);
    }
  });

  it('should work for all valid styles', async () => {
    for (const style of Object.keys(STYLE_PROFILES)) {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style,
        budget: 2000,
      });

      expect(result.success).toBe(true);
      expect(result.style).toBe(style);
      expect(Array.isArray(result.recommendations)).toBe(true);
    }
  });
});

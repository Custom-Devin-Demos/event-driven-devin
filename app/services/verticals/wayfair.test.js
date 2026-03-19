// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { getStyleRecommendations, ROOM_PRODUCTS, STYLE_PROFILES } = require('./wayfair');

// Mock telemetry dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
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

describe('wayfair getStyleRecommendations', () => {
  test('should return recommendations for living-room with modern style (original failure condition)', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.room).toBe('living-room');
    expect(result.style).toBe('modern');
    expect(result.recommendations).toBeDefined();
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.totalFound).toBeGreaterThanOrEqual(0);
  });

  test('should return recommendations with correct product fields (sku, name, price populated)', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 2000,
    });

    expect(result.success).toBe(true);
    for (const rec of result.recommendations) {
      expect(rec.product).toBeDefined();
      expect(typeof rec.product).toBe('string');
      expect(rec.price).toBeDefined();
      expect(rec.matchScore).toBeDefined();
      expect(typeof rec.matchScore).toBe('number');
    }
  });

  test('should handle all style profiles without errors', async () => {
    const styles = Object.keys(STYLE_PROFILES);

    for (const style of styles) {
      const result = await getStyleRecommendations({
        room: 'living-room',
        style,
        budget: 1000,
      });

      expect(result.success).toBe(true);
      expect(result.style).toBe(style);
    }
  });

  test('should handle all room types without errors', async () => {
    const rooms = [...new Set(ROOM_PRODUCTS.map(p => p.room))];

    for (const room of rooms) {
      const result = await getStyleRecommendations({
        room,
        style: 'modern',
        budget: 2000,
      });

      expect(result.success).toBe(true);
      expect(result.room).toBe(room);
    }
  });

  test('should throw error for unknown style', async () => {
    await expect(
      getStyleRecommendations({
        room: 'living-room',
        style: 'nonexistent-style',
        budget: 1000,
      })
    ).rejects.toThrow('Unknown style: nonexistent-style');
  });

  test('should respect budget constraint', async () => {
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

  test('should return empty recommendations for zero budget', async () => {
    const result = await getStyleRecommendations({
      room: 'living-room',
      style: 'modern',
      budget: 0,
    });

    expect(result.success).toBe(true);
    expect(result.recommendations).toEqual([]);
    expect(result.totalFound).toBe(0);
  });
});

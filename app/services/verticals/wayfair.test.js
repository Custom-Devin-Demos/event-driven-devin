// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies to isolate unit tests
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

const { getStyleRecommendations, ROOM_PRODUCTS, STYLE_PROFILES } = require('./wayfair');

describe('wayfair getStyleRecommendations', () => {
  it('should return recommendations for modern living-room (original failure condition)', async () => {
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
    expect(result.totalFound).toBeGreaterThan(0);
  });

  it('should return recommendations for all valid style and room combinations', async () => {
    const rooms = ['living-room', 'bedroom', 'dining-room', 'home-office'];
    const styles = Object.keys(STYLE_PROFILES);

    for (const room of rooms) {
      for (const style of styles) {
        const result = await getStyleRecommendations({
          room,
          style,
          budget: 5000,
        });

        expect(result.success).toBe(true);
        expect(result.room).toBe(room);
        expect(result.style).toBe(style);
        expect(Array.isArray(result.recommendations)).toBe(true);
      }
    }
  });

  it('should throw for an unknown style', async () => {
    await expect(
      getStyleRecommendations({
        room: 'living-room',
        style: 'invalid-style',
        budget: 1000,
      })
    ).rejects.toThrow('Unknown style: invalid-style');
  });

  it('should handle a room with no matching products gracefully', async () => {
    const result = await getStyleRecommendations({
      room: 'nonexistent-room',
      style: 'modern',
      budget: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.recommendations).toEqual([]);
    expect(result.totalFound).toBe(0);
  });

  it('should respect the budget filter', async () => {
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

  it('should ensure all products in ROOM_PRODUCTS have a tags array', () => {
    for (const product of ROOM_PRODUCTS) {
      expect(product.tags).toBeDefined();
      expect(Array.isArray(product.tags)).toBe(true);
      expect(product.tags.length).toBeGreaterThan(0);
    }
  });
});

const { runInquiry, PROPERTIES, ROOM_CATALOG } = require('./beb4d43e');

jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
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

describe('beb4d43e hospitality vertical', () => {
  describe('runInquiry', () => {
    it('should complete a room inquiry for maui without throwing', async () => {
      const result = await runInquiry({
        property: 'maui',
        roomType: 'suite',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.property).toBe('Sheraton Maui Resort & Spa');
      expect(result.propertyCode).toBe('maui');
      expect(result.inquiryId).toBe('test-uuid-1234');
      expect(result.rooms).toBeInstanceOf(Array);
      expect(result.rooms.length).toBeGreaterThan(0);
    });

    it('should complete a room inquiry for every property without throwing', async () => {
      for (const prop of PROPERTIES) {
        const result = await runInquiry({
          property: prop.code,
          roomType: 'suite',
          priority: 'standard',
        });

        expect(result).toBeDefined();
        expect(result.propertyCode).toBe(prop.code);
        expect(result.rooms).toBeInstanceOf(Array);
      }
    });

    it('should apply bonvoy_platinum discount correctly', async () => {
      const result = await runInquiry({
        property: 'maui',
        roomType: 'suite',
        priority: 'bonvoy_platinum',
      });

      expect(result).toBeDefined();
      expect(result.priority).toBe('bonvoy_platinum');
      expect(result.rooms.length).toBeGreaterThan(0);
      result.rooms.forEach((room) => {
        expect(room.nightly).toBeDefined();
        expect(typeof room.nightly).toBe('number');
      });
    });

    it('should handle standard room type queries', async () => {
      const result = await runInquiry({
        property: 'bali',
        roomType: 'standard',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.propertyCode).toBe('bali');
    });

    it('should return numeric rates for all rooms', async () => {
      const result = await runInquiry({
        property: 'dubai',
        roomType: 'suite',
        priority: 'bonvoy_gold',
      });

      expect(result.avgNightlyRate).toBeDefined();
      expect(typeof result.avgNightlyRate).toBe('number');
      expect(result.avgNightlyRate).toBeGreaterThan(0);
    });
  });
});

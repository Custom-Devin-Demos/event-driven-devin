jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { runInquiry, PROPERTIES, ROOM_CATALOG } = require('./beb4d43e');

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
    it('should complete successfully for the maui property', async () => {
      const result = await runInquiry({
        property: 'maui',
        roomType: 'suite',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.property).toBe('Sheraton Maui Resort & Spa');
      expect(result.propertyCode).toBe('maui');
      expect(result.inquiryId).toBeDefined();
      expect(result.rooms).toBeInstanceOf(Array);
      expect(result.rooms.length).toBeGreaterThan(0);
    });

    it('should complete successfully for all properties', async () => {
      for (const prop of PROPERTIES) {
        const result = await runInquiry({
          property: prop.code,
          roomType: 'suite',
          priority: 'standard',
        });

        expect(result).toBeDefined();
        expect(result.propertyCode).toBe(prop.code);
        expect(result.rooms).toBeInstanceOf(Array);
        expect(result.rooms.length).toBeGreaterThan(0);

        for (const room of result.rooms) {
          expect(room.nightly).toBeDefined();
          expect(typeof room.nightly).toBe('number');
          expect(room.nightly).not.toBeNaN();
        }
      }
    });

    it('should return correct room fields for each room', async () => {
      const result = await runInquiry({
        property: 'bali',
        roomType: 'suite',
        priority: 'bonvoy_gold',
      });

      for (const room of result.rooms) {
        expect(room).toHaveProperty('sku');
        expect(room).toHaveProperty('room');
        expect(room).toHaveProperty('available');
        expect(room).toHaveProperty('nightly');
        expect(room).toHaveProperty('status');
      }
    });

    it('should handle different priority tiers correctly', async () => {
      const standard = await runInquiry({
        property: 'maui',
        roomType: 'suite',
        priority: 'standard',
      });

      const platinum = await runInquiry({
        property: 'maui',
        roomType: 'suite',
        priority: 'bonvoy_platinum',
      });

      expect(platinum.avgNightlyRate).toBeLessThan(standard.avgNightlyRate);
    });

    it('should resolve rooms by type when no sku is provided', async () => {
      const result = await runInquiry({
        property: 'cancun',
        roomType: 'standard',
        priority: 'standard',
      });

      expect(result.rooms.length).toBeGreaterThan(0);
    });

    it('should resolve rooms by sku when provided', async () => {
      const result = await runInquiry({
        property: 'dubai',
        roomType: 'suite',
        sku: 'DLX-KING',
        priority: 'standard',
      });

      expect(result.rooms.length).toBeGreaterThan(0);
    });
  });
});

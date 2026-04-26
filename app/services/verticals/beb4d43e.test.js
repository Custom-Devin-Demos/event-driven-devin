jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../../telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../../telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));

const {
  getRoomAvailability,
  computeBookingMetrics,
  calculateStayTotal,
  runInquiry,
  PROPERTIES,
  ROOM_CATALOG,
  INVENTORY,
} = require('./beb4d43e');

describe('beb4d43e hospitality vertical', () => {
  describe('getRoomAvailability', () => {
    it('should return inventory data with available and total counts for a valid property', () => {
      const result = getRoomAvailability('maui');
      expect(result).not.toBeNull();
      expect(result.inventory).toBeDefined();
      expect(typeof result.inventory.available).toBe('number');
      expect(typeof result.inventory.total).toBe('number');
      expect(typeof result.inventory.occupancyRate).toBe('string');
      expect(result.breakdown).toBeDefined();
    });

    it('should return null for an unknown property', () => {
      const result = getRoomAvailability('atlantis');
      expect(result).toBeNull();
    });

    it('should return inventory (not capacity) as the key name', () => {
      const result = getRoomAvailability('oahu');
      expect(result).toHaveProperty('inventory');
      expect(result).not.toHaveProperty('capacity');
    });
  });

  describe('computeBookingMetrics', () => {
    it('should compute metrics without throwing for valid rooms and property', () => {
      const rooms = [{ ...ROOM_CATALOG.suite, available: INVENTORY.maui.suite }];
      expect(() => computeBookingMetrics(rooms, 'maui')).not.toThrow();
    });

    it('should return adjusted rate and occupancy for each room', () => {
      const rooms = [{ ...ROOM_CATALOG.standard, available: INVENTORY.maui.standard }];
      const metrics = computeBookingMetrics(rooms, 'maui');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toHaveProperty('sku', 'STD-100');
      expect(metrics[0]).toHaveProperty('adjustedRate');
      expect(metrics[0]).toHaveProperty('occupancyRate');
      expect(metrics[0]).toHaveProperty('lowAvailability');
    });

    it('should access availability.inventory.available (not capacity.available)', () => {
      const rooms = [{ ...ROOM_CATALOG.deluxe, available: INVENTORY.kauai.deluxe }];
      const metrics = computeBookingMetrics(rooms, 'kauai');
      expect(parseFloat(metrics[0].adjustedRate)).toBeGreaterThan(0);
    });

    it('should handle all property codes without TypeError', () => {
      const propertyKeys = Object.keys(PROPERTIES);
      for (const prop of propertyKeys) {
        const rooms = [{ ...ROOM_CATALOG.standard, available: INVENTORY[prop].standard }];
        expect(() => computeBookingMetrics(rooms, prop)).not.toThrow();
      }
    });
  });

  describe('calculateStayTotal', () => {
    it('should compute a stay total for a valid property', () => {
      const result = calculateStayTotal(449, 3, 'maui');
      expect(result).not.toBeNull();
      expect(parseFloat(result.total)).toBeGreaterThan(0);
      expect(result.seasonFactor).toBe(1.35);
    });

    it('should return null for an unknown property', () => {
      const result = calculateStayTotal(449, 3, 'unknown');
      expect(result).toBeNull();
    });

    it('should include resort fee in the total', () => {
      const result = calculateStayTotal(100, 2, 'oahu');
      expect(parseFloat(result.resortFee)).toBe(70);
    });
  });

  describe('runInquiry', () => {
    it('should succeed for a valid property and room type', async () => {
      const result = await runInquiry({ property: 'maui', roomType: 'suite', nights: 3, guests: 2 });
      expect(result.success).toBe(true);
      expect(result.property).toBe('Maui Shores Resort');
      expect(result.roomType).toBe('suite');
      expect(result.metrics).toBeDefined();
      expect(result.stayEstimate).toBeDefined();
    });

    it('should throw PropertyNotFoundError for an unknown property', async () => {
      await expect(runInquiry({ property: 'atlantis', roomType: 'suite' }))
        .rejects.toThrow('Unknown property: atlantis');
    });

    it('should throw RoomTypeError for an unknown room type', async () => {
      await expect(runInquiry({ property: 'maui', roomType: 'treehouse' }))
        .rejects.toThrow('Unknown room type: treehouse');
    });
  });
});

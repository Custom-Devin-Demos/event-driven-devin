jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));
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

const { runInquiry, DATACENTERS, PROCESSOR_CATALOG } = require('./1a459b91');

describe('1a459b91 — Processor Allocation Inquiry', () => {
  describe('runInquiry', () => {
    it('should complete successfully for a standard priority inquiry at hillsboro', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.facility).toBe('Hillsboro D1X');
      expect(result.facilityCode).toBe('hillsboro');
      expect(result.inquiryId).toBeDefined();
      expect(result.lineItems).toBeInstanceOf(Array);
      expect(result.lineItems.length).toBeGreaterThan(0);
    });

    it('should not throw TypeError when accessing throughput.fabrication.daily', async () => {
      await expect(
        runInquiry({
          facility: 'hillsboro',
          category: 'core',
          priority: 'standard',
        })
      ).resolves.not.toThrow();
    });

    it('should work for all datacenters', async () => {
      for (const dc of DATACENTERS) {
        const result = await runInquiry({
          facility: dc.code,
          category: 'core',
          priority: 'standard',
        });
        expect(result).toBeDefined();
        expect(result.facilityCode).toBe(dc.code);
        expect(result.lineItems).toBeInstanceOf(Array);
      }
    });

    it('should work for all priority levels', async () => {
      for (const priority of ['standard', 'expedited', 'emergency']) {
        const result = await runInquiry({
          facility: 'hillsboro',
          category: 'core',
          priority,
        });
        expect(result).toBeDefined();
        expect(result.priority).toBe(priority);
      }
    });

    it('should work for all processor categories', async () => {
      const categories = [...new Set(PROCESSOR_CATALOG.map((p) => p.category))];
      for (const category of categories) {
        const result = await runInquiry({
          facility: 'hillsboro',
          category,
          priority: 'standard',
        });
        expect(result).toBeDefined();
        expect(result.lineItems.length).toBeGreaterThan(0);
      }
    });

    it('should return numeric estimatedLeadDays and availableUnits', async () => {
      const result = await runInquiry({
        facility: 'chandler',
        category: 'xeon',
        priority: 'expedited',
      });
      expect(typeof result.estimatedLeadDays).toBe('number');
      expect(typeof result.availableUnits).toBe('number');
      expect(result.availableUnits).toBeGreaterThan(0);
    });

    it('should calculate expedite cost for expedited priority', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'expedited',
      });
      expect(result.expediteCost).toBeDefined();
      expect(parseFloat(result.expediteCost)).toBeGreaterThan(0);
    });

    it('should filter by partNumber when provided', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'standard',
        partNumber: 'i9-14900K',
      });
      expect(result).toBeDefined();
      expect(result.lineItems.length).toBeGreaterThan(0);
      expect(result.lineItems[0].partNumber).toBe('i9-14900K');
    });
  });
});

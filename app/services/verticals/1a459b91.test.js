const {
  runInquiry,
  DATACENTERS,
  PROCESSOR_CATALOG,
} = require('./1a459b91');

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

describe('1a459b91 - Processor Allocation Inquiry', () => {
  describe('runInquiry', () => {
    it('should complete successfully for hillsboro facility with standard priority', async () => {
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
      expect(result.availableUnits).toBeGreaterThan(0);
      expect(result.estimatedLeadDays).toBeGreaterThan(0);
    });

    it('should complete successfully for all datacenters', async () => {
      for (const dc of DATACENTERS) {
        const result = await runInquiry({
          facility: dc.code,
          category: 'core',
          priority: 'standard',
        });

        expect(result).toBeDefined();
        expect(result.facilityCode).toBe(dc.code);
        expect(result.region).toBe(dc.region);
        expect(result.lineItems).toBeInstanceOf(Array);
      }
    });

    it('should handle expedited priority with correct expedite costs', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'expedited',
      });

      expect(result).toBeDefined();
      expect(result.priority).toBe('expedited');
      expect(parseFloat(result.expediteCost)).toBeGreaterThan(0);
    });

    it('should handle emergency priority', async () => {
      const result = await runInquiry({
        facility: 'chandler',
        category: 'xeon',
        priority: 'emergency',
      });

      expect(result).toBeDefined();
      expect(result.priority).toBe('emergency');
    });

    it('should filter processors by category', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'xeon',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.lineItems.length).toBe(
        PROCESSOR_CATALOG.filter((p) => p.category === 'xeon').length,
      );
    });

    it('should return throughput data in line items', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'standard',
      });

      for (const item of result.lineItems) {
        expect(item.partNumber).toBeDefined();
        expect(item.processor).toBeDefined();
        expect(typeof item.available).toBe('number');
        expect(typeof item.leadDays).toBe('number');
        expect(['REORDER_NOW', 'ADEQUATE']).toContain(item.urgency);
      }
    });

    it('should correctly identify critical shortages (items below reorder point)', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'ultra',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      const ultraProc = PROCESSOR_CATALOG.find((p) => p.category === 'ultra');
      if (ultraProc && ultraProc.stock < ultraProc.reorderPoint) {
        expect(result.criticalShortages).toBeGreaterThan(0);
      }
    });

    it('should handle partNumber filtering', async () => {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority: 'standard',
        partNumber: 'i9-14900K',
      });

      expect(result).toBeDefined();
      expect(result.lineItems.length).toBeGreaterThan(0);
    });
  });
});

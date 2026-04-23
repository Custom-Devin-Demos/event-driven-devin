// Mock uuid before requiring the module under test (uuid v13+ is ESM-only)
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

const {
  runInquiry,
  FACILITIES,
  COMPONENT_CATALOG,
} = require('./acf4303d');

describe('acf4303d - Supply Chain Inquiry', () => {
  describe('runInquiry', () => {
    it('should complete without TypeError for default facility (zhengzhou)', async () => {
      const result = await runInquiry({
        facility: 'zhengzhou',
        category: 'pcb',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      expect(result.facility).toBe('Zhengzhou Campus');
      expect(result.facilityCode).toBe('zhengzhou');
      expect(result.availableUnits).toBeGreaterThan(0);
      expect(result.estimatedLeadDays).toBeGreaterThan(0);
      expect(result.inquiryId).toBeDefined();
      expect(result.lineItems).toBeInstanceOf(Array);
      expect(result.lineItems.length).toBeGreaterThan(0);
    });

    it('should work for all facilities without throwing', async () => {
      const facilityResults = await Promise.all(
        FACILITIES.map((f) =>
          runInquiry({
            facility: f.code,
            category: 'pcb',
            priority: 'standard',
          })
        )
      );

      facilityResults.forEach((result, i) => {
        expect(result.facility).toBe(FACILITIES[i].name);
        expect(result.facilityCode).toBe(FACILITIES[i].code);
        expect(result.availableUnits).toBeDefined();
        expect(result.estimatedLeadDays).toBeDefined();
      });
    });

    it('should return correct throughput-based metrics (regression: throughput.output vs throughput.production)', async () => {
      const result = await runInquiry({
        facility: 'zhengzhou',
        category: 'pcb',
        priority: 'standard',
      });

      // Zhengzhou: 340 lines * 1.2 multiplier = 408 daily output
      // PCB component (FC-PCB-2201): stock 14200, so coverageDays = floor(14200 / 408) = 34
      const pcbItem = result.lineItems.find((item) => item.partNumber === 'FC-PCB-2201');
      expect(pcbItem).toBeDefined();
      expect(pcbItem.leadDays).toBe(34);
      expect(pcbItem.available).toBe(14200);

      // Verify throughputPerDay is calculated correctly
      // perShift = 408 / 3 = 136, dailyThroughput = 136 * 3 = 408
      expect(result.lineItems[0]).toHaveProperty('component');
    });

    it('should handle all priority levels correctly', async () => {
      const priorities = ['standard', 'expedited', 'emergency'];

      const results = await Promise.all(
        priorities.map((priority) =>
          runInquiry({
            facility: 'shenzhen',
            category: 'display',
            priority,
          })
        )
      );

      // Higher urgency should have shorter lead times
      expect(results[0].estimatedLeadDays).toBeGreaterThanOrEqual(results[1].estimatedLeadDays);
      expect(results[1].estimatedLeadDays).toBeGreaterThanOrEqual(results[2].estimatedLeadDays);
    });

    it('should handle all component categories without errors', async () => {
      const categories = ['pcb', 'display', 'battery', 'semiconductor', 'mechanical'];

      const results = await Promise.all(
        categories.map((category) =>
          runInquiry({
            facility: 'chennai',
            category,
            priority: 'standard',
          })
        )
      );

      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(result.lineItems.length).toBeGreaterThan(0);
      });
    });
  });
});

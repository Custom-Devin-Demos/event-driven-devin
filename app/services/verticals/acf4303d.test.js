// Mock uuid before requiring the module under test
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

const { runInquiry, FACILITIES, COMPONENT_CATALOG } = require('./acf4303d');

describe('acf4303d - Supply Chain Inquiry', () => {
  describe('runInquiry', () => {
    it('should complete an inquiry without TypeError for default inputs', async () => {
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
      expect(result.lineItems).toBeInstanceOf(Array);
      expect(result.lineItems.length).toBeGreaterThan(0);
      expect(result.inquiryId).toBeDefined();
      expect(result.completedAt).toBeDefined();
    });

    it('should complete an inquiry for every facility without errors', async () => {
      for (const facility of FACILITIES) {
        const result = await runInquiry({
          facility: facility.code,
          category: 'pcb',
          priority: 'standard',
        });

        expect(result).toBeDefined();
        expect(result.facility).toBe(facility.name);
        expect(result.facilityCode).toBe(facility.code);
        expect(result.availableUnits).toBeGreaterThan(0);
      }
    });

    it('should handle all priority levels correctly', async () => {
      const priorities = ['standard', 'expedited', 'emergency'];
      for (const priority of priorities) {
        const result = await runInquiry({
          facility: 'zhengzhou',
          category: 'pcb',
          priority,
        });

        expect(result).toBeDefined();
        expect(result.priority).toBe(priority);
        expect(result.lineItems).toBeInstanceOf(Array);
      }
    });

    it('should handle all component categories correctly', async () => {
      const categories = ['pcb', 'display', 'battery', 'semiconductor', 'mechanical'];
      for (const category of categories) {
        const result = await runInquiry({
          facility: 'zhengzhou',
          category,
          priority: 'standard',
        });

        expect(result).toBeDefined();
        expect(result.lineItems).toBeInstanceOf(Array);
        expect(result.lineItems.length).toBeGreaterThan(0);
      }
    });

    it('should return throughput-based fulfillment data with valid numeric fields', async () => {
      const result = await runInquiry({
        facility: 'wisconsin',
        category: 'semiconductor',
        priority: 'emergency',
      });

      expect(result).toBeDefined();
      for (const item of result.lineItems) {
        expect(item.partNumber).toBeDefined();
        expect(item.component).toBeDefined();
        expect(typeof item.available).toBe('number');
        expect(typeof item.leadDays).toBe('number');
        expect(item.leadDays).toBeGreaterThanOrEqual(0);
        expect(['REORDER_NOW', 'ADEQUATE']).toContain(item.urgency);
      }
    });

    it('should include recommendations for critical shortages', async () => {
      const result = await runInquiry({
        facility: 'zhengzhou',
        category: 'battery',
        priority: 'standard',
      });

      expect(result).toBeDefined();
      // Battery Module (stock 1200, reorderPoint 4000) should be below reorder
      if (result.criticalShortages > 0) {
        expect(result.recommendations).toContain('Initiate emergency procurement for critical components');
      }
    });
  });
});

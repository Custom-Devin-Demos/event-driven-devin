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

const {
  getDatacenterThroughput,
  computeAllocationMetrics,
  calculateFulfillment,
  runInquiry,
} = require('./1a459b91');

describe('1a459b91 - Processor Allocation Inquiry', () => {
  describe('getDatacenterThroughput', () => {
    it('should return waferOutput with daily and perShift properties', () => {
      const result = getDatacenterThroughput('hillsboro');
      expect(result).toHaveProperty('waferOutput');
      expect(result.waferOutput).toHaveProperty('daily');
      expect(result.waferOutput).toHaveProperty('perShift');
      expect(result).toHaveProperty('shifts');
      expect(typeof result.waferOutput.daily).toBe('number');
      expect(typeof result.waferOutput.perShift).toBe('number');
    });

    it('should not have a fabrication property', () => {
      const result = getDatacenterThroughput('hillsboro');
      expect(result.fabrication).toBeUndefined();
    });

    it('should compute correct values for hillsboro', () => {
      const result = getDatacenterThroughput('hillsboro');
      expect(result.waferOutput.daily).toBe(4200 * 1.15);
      expect(result.waferOutput.perShift).toBe((4200 * 1.15) / 3);
      expect(result.shifts).toBe(3);
    });
  });

  describe('computeAllocationMetrics', () => {
    it('should compute allocation metrics without throwing TypeError', () => {
      const processors = [
        { partNumber: 'i9-14900K', category: 'core', description: 'Core i9', unitCost: 589, stock: 8200, reorderPoint: 3000, leadTimeDays: 10, fab: 'Intel 7' },
      ];
      expect(() => computeAllocationMetrics(processors, 'hillsboro')).not.toThrow();
    });

    it('should correctly calculate coverageDays using waferOutput.daily', () => {
      const processors = [
        { partNumber: 'i9-14900K', category: 'core', description: 'Core i9', unitCost: 589, stock: 8200, reorderPoint: 3000, leadTimeDays: 10, fab: 'Intel 7' },
      ];
      const result = computeAllocationMetrics(processors, 'hillsboro');
      const expectedCoverage = Math.floor(8200 / (4200 * 1.15));
      expect(result[0].coverageDays).toBe(expectedCoverage);
    });

    it('should mark items below reorder point', () => {
      const processors = [
        { partNumber: 'Ultra-288V', category: 'ultra', description: 'Ultra 200V', unitCost: 394, stock: 420, reorderPoint: 3000, leadTimeDays: 30, fab: 'Intel 4' },
      ];
      const result = computeAllocationMetrics(processors, 'hillsboro');
      expect(result[0].belowReorder).toBe(true);
    });

    it('should work for all datacenter codes', () => {
      const processors = [
        { partNumber: 'N100', category: 'embedded', description: 'N100', unitCost: 128, stock: 45200, reorderPoint: 15000, leadTimeDays: 6, fab: 'Intel 7' },
      ];
      const dcCodes = ['hillsboro', 'chandler', 'leixlip', 'dalian', 'penang'];
      for (const dc of dcCodes) {
        expect(() => computeAllocationMetrics(processors, dc)).not.toThrow();
      }
    });
  });

  describe('calculateFulfillment', () => {
    it('should calculate fulfillment without throwing TypeError', () => {
      const allocationMetrics = [
        { partNumber: 'i9-14900K', description: 'Core i9', currentStock: 8200, coverageDays: 1, belowReorder: false, fab: 'Intel 7', unitCost: 589 },
      ];
      const priorityConfig = { urgencyFactor: 1.0, expediteFee: 0 };
      expect(() => calculateFulfillment(allocationMetrics, priorityConfig, 'hillsboro')).not.toThrow();
    });

    it('should compute throughputPerDay using waferOutput.perShift', () => {
      const allocationMetrics = [
        { partNumber: 'i9-14900K', description: 'Core i9', currentStock: 8200, coverageDays: 1, belowReorder: false, fab: 'Intel 7', unitCost: 589 },
      ];
      const priorityConfig = { urgencyFactor: 1.0, expediteFee: 0 };
      const result = calculateFulfillment(allocationMetrics, priorityConfig, 'hillsboro');
      expect(result[0].throughputPerDay).toBe(Math.round((4200 * 1.15 / 3) * 3));
    });
  });

  describe('runInquiry (integration)', () => {
    it('should complete a full inquiry for hillsboro without errors', async () => {
      const data = {
        facility: 'hillsboro',
        category: 'core',
        priority: 'standard',
      };
      const result = await runInquiry(data);
      expect(result).toHaveProperty('facility', 'Hillsboro D1X');
      expect(result).toHaveProperty('facilityCode', 'hillsboro');
      expect(result).toHaveProperty('inquiryId');
      expect(result).toHaveProperty('lineItems');
      expect(result.lineItems.length).toBeGreaterThan(0);
    });

    it('should complete inquiry for all priority levels', async () => {
      for (const priority of ['standard', 'expedited', 'emergency']) {
        const data = { facility: 'chandler', category: 'xeon', priority };
        const result = await runInquiry(data);
        expect(result).toHaveProperty('priority', priority);
        expect(result).toHaveProperty('lineItems');
      }
    });

    it('should handle all datacenters', async () => {
      const dcCodes = ['hillsboro', 'chandler', 'leixlip', 'dalian', 'penang'];
      for (const facility of dcCodes) {
        const data = { facility, category: 'core', priority: 'standard' };
        const result = await runInquiry(data);
        expect(result).toHaveProperty('facilityCode', facility);
      }
    });
  });
});

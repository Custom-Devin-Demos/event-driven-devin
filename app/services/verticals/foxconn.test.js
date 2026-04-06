// Mock uuid before requiring foxconn
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

const { runInquiry, FACILITIES, COMPONENT_CATALOG } = require('./foxconn');

describe('foxconn supply chain - runInquiry', () => {
  test('should complete inquiry for zhengzhou facility with pcb category', async () => {
    const result = await runInquiry({
      facility: 'zhengzhou',
      category: 'pcb',
      priority: 'standard',
    });

    expect(result).toBeDefined();
    expect(result.facility).toBe('Zhengzhou Campus');
    expect(result.facilityCode).toBe('zhengzhou');
    expect(result.inquiryId).toBeDefined();
    expect(result.availableUnits).toBeGreaterThan(0);
    expect(result.estimatedLeadDays).toBeGreaterThan(0);
    expect(result.lineItems).toBeInstanceOf(Array);
    expect(result.lineItems.length).toBeGreaterThan(0);
  });

  test('should complete inquiry for all facilities without errors', async () => {
    const facilities = ['zhengzhou', 'shenzhen', 'chennai', 'wisconsin', 'vietnam'];
    for (const facility of facilities) {
      const result = await runInquiry({
        facility,
        category: 'pcb',
        priority: 'standard',
      });
      expect(result).toBeDefined();
      expect(result.facilityCode).toBe(facility);
      expect(result.lineItems).toBeInstanceOf(Array);
    }
  });

  test('should complete inquiry with all priority levels', async () => {
    const priorities = ['standard', 'expedited', 'emergency'];
    for (const priority of priorities) {
      const result = await runInquiry({
        facility: 'zhengzhou',
        category: 'pcb',
        priority,
      });
      expect(result).toBeDefined();
      expect(result.priority).toBe(priority);
    }
  });

  test('should complete inquiry for all component categories', async () => {
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

  test('should return correct throughput-derived coverage days (not NaN or undefined)', async () => {
    const result = await runInquiry({
      facility: 'zhengzhou',
      category: 'pcb',
      priority: 'standard',
    });

    for (const item of result.lineItems) {
      expect(item.leadDays).toBeDefined();
      expect(typeof item.leadDays).toBe('number');
      expect(Number.isNaN(item.leadDays)).toBe(false);
    }
  });

  test('should include expedite cost for expedited priority', async () => {
    const result = await runInquiry({
      facility: 'zhengzhou',
      category: 'pcb',
      priority: 'expedited',
    });

    expect(result).toBeDefined();
    expect(parseFloat(result.expediteCost)).toBeGreaterThan(0);
  });
});

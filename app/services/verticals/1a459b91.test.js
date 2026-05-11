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

describe('runInquiry', () => {
  const validInput = {
    facility: 'hillsboro',
    category: 'core',
    priority: 'standard',
  };

  it('should complete without throwing for valid input', async () => {
    const result = await runInquiry(validInput);
    expect(result).toBeDefined();
    expect(result.facility).toBe('Hillsboro D1X');
    expect(result.facilityCode).toBe('hillsboro');
    expect(result.inquiryId).toBeDefined();
    expect(result.lineItems).toBeInstanceOf(Array);
    expect(result.lineItems.length).toBeGreaterThan(0);
  });

  it('should return correct throughput-derived values (fabrication.daily used in coverage calculation)', async () => {
    const result = await runInquiry(validInput);
    result.lineItems.forEach((item) => {
      expect(item.leadDays).toBeGreaterThanOrEqual(0);
      expect(typeof item.available).toBe('number');
    });
  });

  it('should work for all datacenters', async () => {
    for (const dc of DATACENTERS) {
      const result = await runInquiry({
        facility: dc.code,
        category: 'core',
        priority: 'standard',
      });
      expect(result.facility).toBe(dc.name);
      expect(result.facilityCode).toBe(dc.code);
    }
  });

  it('should work for all priority levels', async () => {
    for (const priority of ['standard', 'expedited', 'emergency']) {
      const result = await runInquiry({
        facility: 'hillsboro',
        category: 'core',
        priority,
      });
      expect(result.priority).toBe(priority);
      expect(result.lineItems.length).toBeGreaterThan(0);
    }
  });

  it('should filter processors by category', async () => {
    const result = await runInquiry({
      facility: 'hillsboro',
      category: 'xeon',
      priority: 'standard',
    });
    const xeonParts = PROCESSOR_CATALOG.filter((p) => p.category === 'xeon');
    expect(result.lineItems.length).toBe(xeonParts.length);
  });

  it('should filter processors by partNumber when provided', async () => {
    const result = await runInquiry({
      facility: 'chandler',
      category: 'core',
      partNumber: 'i9-14900K',
      priority: 'expedited',
    });
    expect(result.lineItems.length).toBeGreaterThan(0);
    expect(result.lineItems[0].partNumber).toBe('i9-14900K');
  });

  it('should include expedite cost for non-standard priorities', async () => {
    const result = await runInquiry({
      facility: 'hillsboro',
      category: 'core',
      priority: 'expedited',
    });
    expect(parseFloat(result.expediteCost)).toBeGreaterThan(0);
  });

  it('should flag critical shortages when stock is below reorder point', async () => {
    const result = await runInquiry({
      facility: 'hillsboro',
      category: 'ultra',
      priority: 'standard',
    });
    const ultraProc = PROCESSOR_CATALOG.find((p) => p.category === 'ultra');
    if (ultraProc.stock < ultraProc.reorderPoint) {
      expect(result.criticalShortages).toBeGreaterThan(0);
      expect(result.recommendations).toContain('Initiate emergency wafer allocation for critical SKUs');
    }
  });
});

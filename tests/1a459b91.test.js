const {
  runInquiry,
  getDatacenterThroughput,
  DATACENTERS,
  DATACENTER_CAPACITY,
} = require('../app/services/verticals/1a459b91');

describe('Processor allocation inquiry service (1a459b91)', () => {
  test('runs the inquiry that previously threw TypeError reading \'daily\'', async () => {
    const result = await runInquiry({
      facility: 'hillsboro',
      category: 'core',
      priority: 'standard',
    });

    expect(result.facilityCode).toBe('hillsboro');
    expect(result.lineItems.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.estimatedLeadDays)).toBe(true);
    expect(result.lineItems.every((i) => Number.isFinite(i.leadDays))).toBe(true);
  });

  test('throughput exposes the fabrication shape its consumers read', () => {
    for (const dc of DATACENTERS) {
      const throughput = getDatacenterThroughput(dc.code);
      expect(typeof throughput.fabrication.daily).toBe('number');
      expect(typeof throughput.fabrication.perShift).toBe('number');
      expect(throughput.shifts).toBe(DATACENTER_CAPACITY[dc.code].shiftCount);
    }
  });

  test('every facility resolves an inquiry for every priority', async () => {
    for (const dc of DATACENTERS) {
      for (const priority of ['standard', 'expedited', 'emergency']) {
        const result = await runInquiry({ facility: dc.code, category: 'xeon', priority });
        expect(result.facilityCode).toBe(dc.code);
        expect(Number.isFinite(Number(result.expediteCost))).toBe(true);
      }
    }
  });

  test('an unknown facility fails with an explicit error, not a TypeError', async () => {
    await expect(runInquiry({ facility: 'nowhere', category: 'core', priority: 'standard' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_FACILITY' });
    expect(() => getDatacenterThroughput(undefined)).toThrow(/Unknown facility/);
  });

  test('an unknown priority falls back to standard multipliers', async () => {
    const fallback = await runInquiry({ facility: 'chandler', category: 'core', priority: 'rush' });
    const standard = await runInquiry({ facility: 'chandler', category: 'core', priority: 'standard' });

    expect(fallback.expediteCost).toBe(standard.expediteCost);
    expect(fallback.estimatedLeadDays).toBe(standard.estimatedLeadDays);
  });
});

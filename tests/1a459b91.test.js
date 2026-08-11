const {
  runInquiry,
  getDatacenterThroughput,
  DATACENTERS,
  DATACENTER_CAPACITY,
  PRIORITY_MULTIPLIERS,
} = require('../app/services/verticals/1a459b91');

describe('Processor allocation inquiry service (1a459b91)', () => {
  test('completes the inquiry that previously threw on throughput.fabrication.daily', async () => {
    const result = await runInquiry({
      facility: 'hillsboro',
      category: 'core',
      priority: 'expedited',
    });

    expect(result.facilityCode).toBe('hillsboro');
    expect(result.facility).toBe('Hillsboro D1X');
    expect(result.lineItems.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.estimatedLeadDays)).toBe(true);
    result.lineItems.forEach((item) => {
      expect(Number.isFinite(item.leadDays)).toBe(true);
    });
  });

  test('exposes throughput under the fabrication key consumers read', () => {
    const throughput = getDatacenterThroughput('hillsboro');
    const dc = DATACENTERS.find((d) => d.code === 'hillsboro');
    const capacity = DATACENTER_CAPACITY.hillsboro;

    expect(throughput.fabrication.daily).toBeCloseTo(dc.nodes * capacity.yieldMultiplier);
    expect(throughput.fabrication.perShift).toBeCloseTo(
      (dc.nodes * capacity.yieldMultiplier) / capacity.shiftCount,
    );
    expect(throughput.shifts).toBe(capacity.shiftCount);
  });

  test('every datacenter has capacity config and yields finite throughput', () => {
    DATACENTERS.forEach((dc) => {
      expect(DATACENTER_CAPACITY[dc.code]).toBeDefined();
      const throughput = getDatacenterThroughput(dc.code);
      expect(Number.isFinite(throughput.fabrication.daily)).toBe(true);
      expect(Number.isFinite(throughput.fabrication.perShift)).toBe(true);
    });
  });

  test('falls back to a known datacenter for an unknown facility instead of throwing', async () => {
    expect(() => getDatacenterThroughput('does-not-exist')).not.toThrow();

    const result = await runInquiry({ facility: 'does-not-exist', category: 'xeon', priority: 'standard' });
    expect(result.facilityCode).toBe(DATACENTERS[0].code);
  });

  test('falls back to standard multipliers for a missing or unknown priority', async () => {
    const result = await runInquiry({ facility: 'chandler', category: 'xeon' });
    const standardResult = await runInquiry({ facility: 'chandler', category: 'xeon', priority: 'standard' });

    expect(PRIORITY_MULTIPLIERS.standard).toEqual({ urgencyFactor: 1.0, expediteFee: 0 });
    expect(result.expediteCost).toBe(standardResult.expediteCost);
    expect(result.lineItems.map((i) => i.leadDays)).toEqual(standardResult.lineItems.map((i) => i.leadDays));
  });
});

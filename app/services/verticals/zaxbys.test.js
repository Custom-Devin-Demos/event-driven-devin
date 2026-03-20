// Mock uuid ESM module before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-request-id',
}));

// Mock telemetry dependencies to isolate unit tests
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

const { processRewardsLookup, MEMBERS, TIER_THRESHOLDS } = require('./zaxbys');

describe('processRewardsLookup', () => {
  it('should return rewards data without throwing TypeError for a valid member', async () => {
    const result = await processRewardsLookup({
      phone: '(555) 867-5309',
      lastName: 'Johnson',
      location: 'athens-ga',
    });

    expect(result.success).toBe(true);
    expect(result.memberName).toBe('Marcus Johnson');
    expect(result.memberId).toBe('ZAX-4001');
    expect(result.currentTier).toBe('silver');
    expect(typeof result.totalPoints).toBe('number');
    expect(result.totalPoints).toBeGreaterThan(0);
    expect(typeof result.bonusMultiplier).toBe('number');
  });

  it('should correctly compute tier for a member with fewer points (silver tier)', async () => {
    const result = await processRewardsLookup({
      phone: '(555) 234-5678',
      lastName: 'Chen',
      location: 'atlanta-ga',
    });

    expect(result.success).toBe(true);
    expect(result.memberName).toBe('Sarah Chen');
    expect(result.currentTier).toBeDefined();
    expect(typeof result.totalPoints).toBe('number');
  });

  it('should handle a member with low points and still return a valid tier (bronze fallback)', async () => {
    const result = await processRewardsLookup({
      phone: '(555) 345-6789',
      lastName: 'Williams',
      location: 'dallas-tx',
    });

    expect(result.success).toBe(true);
    expect(result.memberName).toBe('David Williams');
    expect(result.currentTier).toBeDefined();
    expect(['gold', 'silver', 'bronze']).toContain(result.currentTier);
    expect(typeof result.totalPoints).toBe('number');
    expect(typeof result.bonusMultiplier).toBe('number');
  });

  it('should throw an error for an unknown phone number', async () => {
    await expect(
      processRewardsLookup({
        phone: '(555) 000-0000',
        lastName: 'Unknown',
        location: 'athens-ga',
      })
    ).rejects.toThrow('No rewards account found for phone');
  });
});

describe('TIER_THRESHOLDS', () => {
  it('should have a tier with minimum 0 to handle all point values', () => {
    const lowestTier = TIER_THRESHOLDS.find(t => t.minimum === 0);
    expect(lowestTier).toBeDefined();
    expect(lowestTier.level).toBeDefined();
    expect(lowestTier.multiplier).toBeDefined();
  });

  it('should have tiers sorted by minimum descending for correct .find() behavior', () => {
    for (let i = 0; i < TIER_THRESHOLDS.length - 1; i++) {
      expect(TIER_THRESHOLDS[i].minimum).toBeGreaterThanOrEqual(TIER_THRESHOLDS[i + 1].minimum);
    }
  });
});

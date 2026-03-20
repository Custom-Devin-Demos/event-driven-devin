/* global jest, describe, it, expect */
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  initDatadog: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processRewardsLookup, MEMBERS, TIER_THRESHOLDS } = require('./zaxbys');

describe('processRewardsLookup', () => {
  it('should return correct tier for a valid rewards member', async () => {
    const result = await processRewardsLookup({
      phone: '(555) 867-5309',
      lastName: 'Johnson',
      location: 'athens-ga',
      userId: 'usr_zaxbys_1',
    });

    expect(result.success).toBe(true);
    expect(result.memberName).toBe('Marcus Johnson');
    expect(result.memberId).toBe('ZAX-4001');
    expect(result.currentTier).toBe('silver');
    expect(result.totalPoints).toBe(710);
    expect(result.bonusMultiplier).toBe(1.5);
    expect(result.homeStore).toBe('athens-ga');
    expect(result.requestId).toBeDefined();
    expect(result.processedAt).toBeDefined();
  });

  it('should return a defined currentTier for all members', async () => {
    const validTiers = TIER_THRESHOLDS.map(t => t.level);

    for (const member of MEMBERS) {
      const result = await processRewardsLookup({
        phone: member.phone,
        lastName: member.name.split(' ').pop(),
        location: member.homeStore,
        userId: 'test_user',
      });

      expect(result.success).toBe(true);
      expect(result.currentTier).toBeDefined();
      expect(typeof result.currentTier).toBe('string');
      expect(validTiers).toContain(result.currentTier);
    }
  });

  it('should throw for an unrecognized phone number', async () => {
    await expect(
      processRewardsLookup({
        phone: '(555) 000-0000',
        lastName: 'Nobody',
        location: 'athens-ga',
        userId: 'test_user',
      }),
    ).rejects.toThrow('No rewards account found');
  });

  it('should compute correct tier thresholds', async () => {
    // ZAX-4001 (Marcus Johnson): earned from visits ~1030, redeemed 320 => net 710 => silver (>=500)
    const silver = await processRewardsLookup({
      phone: '(555) 867-5309',
      lastName: 'Johnson',
      location: 'athens-ga',
      userId: 'test',
    });
    expect(silver.currentTier).toBe('silver');

    // ZAX-4003 (David Williams): earned from visits ~150, redeemed 50 => net 100 => bronze (>=0)
    const bronze = await processRewardsLookup({
      phone: '(555) 345-6789',
      lastName: 'Williams',
      location: 'dallas-tx',
      userId: 'test',
    });
    expect(bronze.currentTier).toBe('bronze');
  });
});

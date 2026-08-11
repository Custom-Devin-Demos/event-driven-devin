const { processAccountActivation } = require('../app/services/verticals/40cf3e09');

describe('40cf3e09 account activation', () => {
  it('activates a free tier account without throwing (regression: NODE-EXPRESS-49)', async () => {
    const result = await processAccountActivation({ planTier: 'free', region: 'us-east-1' });

    expect(result.success).toBe(true);
    expect(result.activation).toMatchObject({
      accountRegion: 'us-east-1',
      zone: 'IAD',
      totalCredits: 200,
      expiresInMonths: 6,
    });
  });

  it('resolves tier terms per geo rather than by array index', async () => {
    const result = await processAccountActivation({ planTier: 'starter', region: 'eu-west-1' });

    expect(result.activation).toMatchObject({
      accountRegion: 'eu-west-1',
      zone: 'DUB',
      totalCredits: 460,
      expiresInMonths: 12,
    });
  });

  it('falls back to the NA schedule for an unmapped region', async () => {
    const result = await processAccountActivation({ planTier: 'free', region: 'mars-central-1' });

    expect(result.activation.totalCredits).toBe(200);
    expect(result.activation.zone).toBe('IAD');
  });

  it('throws an actionable error for an unknown plan tier', async () => {
    await expect(
      processAccountActivation({ planTier: 'enterprise', region: 'us-east-1' })
    ).rejects.toMatchObject({
      code: 'UNKNOWN_PLAN_TIER',
      message: expect.stringContaining('enterprise'),
    });
  });

  it('throws an actionable error when the plan tier is missing', async () => {
    await expect(
      processAccountActivation({ region: 'us-east-1' })
    ).rejects.toMatchObject({ code: 'UNKNOWN_PLAN_TIER' });
  });
});

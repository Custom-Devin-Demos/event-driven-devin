jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../../telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../../telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));

const {
  lookupPlan,
  getSignupQuota,
  validateRegion,
  applyPromoCode,
  buildSignupResponse,
  processSignup,
  PLANS,
  SIGNUP_QUOTAS,
} = require('./99a8ba1a');

describe('99a8ba1a rideshare vertical', () => {
  describe('lookupPlan', () => {
    it('should return plan details for a valid plan', () => {
      const result = lookupPlan('rider');
      expect(result).not.toBeNull();
      expect(result.id).toBe('rider');
      expect(result.details.label).toBe('Rider');
      expect(typeof result.details.monthlyFee).toBe('number');
    });

    it('should return null for an unknown plan', () => {
      const result = lookupPlan('nonexistent');
      expect(result).toBeNull();
    });

    it('should return details for all defined plans', () => {
      for (const planId of Object.keys(PLANS)) {
        const result = lookupPlan(planId);
        expect(result).not.toBeNull();
        expect(result.details).toBeDefined();
      }
    });
  });

  describe('getSignupQuota', () => {
    it('should return allocation with remaining count for a valid plan', () => {
      const result = getSignupQuota('rider');
      expect(result).not.toBeNull();
      expect(result.allocation).toBeDefined();
      expect(typeof result.allocation.remaining).toBe('number');
      expect(typeof result.allocation.total).toBe('number');
      expect(typeof result.allocation.used).toBe('number');
    });

    it('should return allocation (not limits) as the key name', () => {
      const result = getSignupQuota('rider');
      expect(result).toHaveProperty('allocation');
      expect(result).not.toHaveProperty('limits');
    });

    it('should return null for an unknown plan', () => {
      const result = getSignupQuota('nonexistent');
      expect(result).toBeNull();
    });

    it('should calculate remaining correctly', () => {
      const result = getSignupQuota('rider');
      expect(result.allocation.remaining).toBe(
        SIGNUP_QUOTAS.rider.total - SIGNUP_QUOTAS.rider.used,
      );
    });

    it('should handle all plan quotas without TypeError', () => {
      for (const planId of Object.keys(SIGNUP_QUOTAS)) {
        const result = getSignupQuota(planId);
        expect(result).not.toBeNull();
        expect(result.allocation.remaining).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('validateRegion', () => {
    it('should return valid=true for an active region', () => {
      const result = validateRegion('us-west');
      expect(result.valid).toBe(true);
      expect(result.region.name).toBe('US West');
    });

    it('should return valid=false for an unknown region', () => {
      const result = validateRegion('mars');
      expect(result.valid).toBe(false);
    });
  });

  describe('applyPromoCode', () => {
    it('should apply a valid promo code for the correct plan', () => {
      const result = applyPromoCode('SWIFT10', 'rider-plus');
      expect(result.applied).toBe(true);
      expect(result.discount).toBe(0.10);
    });

    it('should reject a promo code for the wrong plan', () => {
      const result = applyPromoCode('SWIFT10', 'rider');
      expect(result.applied).toBe(false);
    });

    it('should return not-applied for null promo', () => {
      const result = applyPromoCode(null, 'rider');
      expect(result.applied).toBe(false);
    });
  });

  describe('buildSignupResponse', () => {
    it('should build a response using allocation.remaining (not limits.remaining)', () => {
      const planInfo = lookupPlan('rider');
      const quotaInfo = getSignupQuota('rider');
      const regionInfo = validateRegion('us-west');
      const promoResult = { applied: false, discount: 0 };

      expect(() => buildSignupResponse(planInfo, quotaInfo, regionInfo, promoResult)).not.toThrow();
      const response = buildSignupResponse(planInfo, quotaInfo, regionInfo, promoResult);
      expect(response.spotsRemaining).toBe(quotaInfo.allocation.remaining);
    });
  });

  describe('processSignup', () => {
    it('should succeed for a rider plan signup', async () => {
      const result = await processSignup({ plan: 'rider', region: 'us-west' });
      expect(result.success).toBe(true);
      expect(result.plan).toBe('Rider');
      expect(result.planId).toBe('rider');
      expect(typeof result.spotsRemaining).toBe('number');
    });

    it('should succeed for all valid plans', async () => {
      for (const planId of Object.keys(PLANS)) {
        const result = await processSignup({ plan: planId, region: 'us-west' });
        expect(result.success).toBe(true);
      }
    });

    it('should throw PlanNotFoundError for an unknown plan', async () => {
      await expect(processSignup({ plan: 'vip-gold', region: 'us-west' }))
        .rejects.toThrow('Unknown plan: vip-gold');
    });

    it('should throw RegionUnavailableError for an unknown region', async () => {
      await expect(processSignup({ plan: 'rider', region: 'mars' }))
        .rejects.toThrow('Region unavailable: mars');
    });
  });
});

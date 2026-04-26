jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

const { runInquiry, DIVISIONS, ROLE_CATALOG } = require('./89c1f355');

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
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

describe('89c1f355 — Recruitment Inquiry', () => {
  describe('runInquiry', () => {
    it('should succeed for the investment-banking division', async () => {
      const result = await runInquiry({ division: 'investment-banking' });

      expect(result).toBeDefined();
      expect(result.division).toBe('Investment Banking');
      expect(result.divisionCode).toBe('investment-banking');
      expect(result.pipeline).toBeDefined();
      expect(result.pipeline.openReqs).toBe(84);
      expect(result.pipeline.activeCandidates).toBe(320);
      expect(result.roles).toBeInstanceOf(Array);
      expect(result.roles.length).toBeGreaterThan(0);
      expect(result.offers).toBeInstanceOf(Array);
      expect(result.inquiryId).toBeDefined();
    });

    it('should compute demandScore using staffing.totalHeadcount without TypeError', async () => {
      const result = await runInquiry({ division: 'investment-banking' });

      for (const role of result.roles) {
        expect(role.demandScore).toBeDefined();
        expect(typeof role.demandScore).toBe('number');
        expect(Number.isFinite(role.demandScore)).toBe(true);
        expect(role.demandScore).toBeGreaterThan(0);
      }
    });

    it('should succeed for all valid divisions', async () => {
      for (const division of DIVISIONS) {
        const result = await runInquiry({ division: division.code });
        expect(result.divisionCode).toBe(division.code);
        expect(result.pipeline).toBeDefined();
        expect(result.pipeline.openReqs).toBeGreaterThanOrEqual(0);
        expect(result.roles).toBeInstanceOf(Array);
      }
    });

    it('should throw for an unknown division', async () => {
      await expect(runInquiry({ division: 'nonexistent' })).rejects.toThrow('Unknown division');
    });

    it('should include offer packages with correct structure', async () => {
      const result = await runInquiry({ division: 'investment-banking' });

      for (const offer of result.offers) {
        expect(offer.roleId).toBeDefined();
        expect(offer.baseSalary).toBeGreaterThan(0);
        expect(offer.totalCompensation).toBeGreaterThanOrEqual(offer.baseSalary);
        expect(typeof offer.budgetImpactPct).toBe('number');
      }
    });

    it('should handle undefined division gracefully', async () => {
      await expect(runInquiry({ division: undefined })).rejects.toThrow();
    });

    it('should handle null division gracefully', async () => {
      await expect(runInquiry({ division: null })).rejects.toThrow();
    });
  });

  describe('DIVISIONS', () => {
    it('should include investment-banking', () => {
      const ib = DIVISIONS.find((d) => d.code === 'investment-banking');
      expect(ib).toBeDefined();
      expect(ib.name).toBe('Investment Banking');
    });
  });

  describe('ROLE_CATALOG', () => {
    it('should have roles for investment-banking', () => {
      const ibRoles = ROLE_CATALOG.filter((r) => r.division === 'investment-banking');
      expect(ibRoles.length).toBeGreaterThan(0);
    });
  });
});

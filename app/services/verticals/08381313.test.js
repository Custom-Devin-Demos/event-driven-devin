const {
  processSupplyInquiry,
  resolveCompany,
  getSectorCompliance,
  aggregateSubsidiaryMetrics,
  buildComplianceReport,
  COMPANIES,
} = require('./08381313');

describe('getSectorCompliance', () => {
  it('includes an auditTrail with a lastAuditDate for every sector', () => {
    for (const company of COMPANIES) {
      const compliance = getSectorCompliance(company);
      expect(compliance.auditTrail).toBeDefined();
      expect(typeof compliance.auditTrail.lastAuditDate).toBe('string');
      expect(Number.isNaN(Date.parse(compliance.auditTrail.lastAuditDate))).toBe(false);
    }
  });

  it('sets lastAuditDate in the past and nextAuditDate in the future', () => {
    const compliance = getSectorCompliance(COMPANIES[0]);
    const now = Date.now();
    expect(Date.parse(compliance.auditTrail.lastAuditDate)).toBeLessThan(now);
    expect(Date.parse(compliance.auditTrail.nextAuditDate)).toBeGreaterThan(now);
  });
});

describe('buildComplianceReport', () => {
  it('builds a report without throwing when given real compliance data (regression for lastAuditDate TypeError)', () => {
    const company = resolveCompany('KII-9204715');
    const compliance = getSectorCompliance(company);
    const subsidiaryData = aggregateSubsidiaryMetrics(company);

    expect(() => buildComplianceReport(company, compliance, subsidiaryData)).not.toThrow();

    const report = buildComplianceReport(company, compliance, subsidiaryData);
    expect(report.compliance.auditTrail).toBe(compliance.auditTrail.lastAuditDate);
  });

  it('throws a clear TypeError if auditTrail is missing (documents the original failure condition)', () => {
    const company = resolveCompany('KII-9204715');
    const subsidiaryData = aggregateSubsidiaryMetrics(company);
    const complianceWithoutAuditTrail = {
      complianceTier: 'standard',
      nextReviewDate: new Date().toISOString(),
      hazmatRequired: true,
    };

    expect(() => buildComplianceReport(company, complianceWithoutAuditTrail, subsidiaryData)).toThrow(
      /lastAuditDate/,
    );
  });
});

describe('processSupplyInquiry', () => {
  it('resolves a full report for the agriculture supply inquiry without throwing', async () => {
    const report = await processSupplyInquiry({
      companyId: 'KII-9204715',
      inquiryType: 'supply_chain_review',
      sector: 'agriculture',
    });

    expect(report.companyId).toBe('KII-9204715');
    expect(report.sector).toBe('agriculture');
    expect(typeof report.compliance.auditTrail).toBe('string');
    expect(report.requestId).toBeTruthy();
  });

  it('falls back to the default company for an unknown companyId', async () => {
    const report = await processSupplyInquiry({
      companyId: 'does-not-exist',
      sector: 'agriculture',
    });

    expect(report.companyId).toBe(COMPANIES[0].id);
    expect(typeof report.compliance.auditTrail).toBe('string');
  });
});

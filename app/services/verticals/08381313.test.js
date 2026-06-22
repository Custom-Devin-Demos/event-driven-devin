jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

const {
  processSupplyInquiry,
  resolveCompany,
  getSectorCompliance,
  aggregateSubsidiaryMetrics,
  buildComplianceReport,
} = require('./08381313');

describe('getSectorCompliance', () => {
  it('includes an auditTrail object with a lastAuditDate', () => {
    const company = resolveCompany('KII-9204715');
    const compliance = getSectorCompliance(company);

    expect(compliance.auditTrail).toBeDefined();
    expect(typeof compliance.auditTrail.lastAuditDate).toBe('string');
    expect(Number.isNaN(Date.parse(compliance.auditTrail.lastAuditDate))).toBe(false);
  });
});

describe('buildComplianceReport', () => {
  // Regression: previously threw "Cannot read properties of undefined (reading 'lastAuditDate')"
  // because getSectorCompliance did not return an auditTrail object (NODE-EXPRESS-2C).
  it('builds a report without throwing for a valid company', () => {
    const company = resolveCompany('KII-9204715');
    const compliance = getSectorCompliance(company);
    const subsidiaryData = aggregateSubsidiaryMetrics(company);

    const report = buildComplianceReport(company, compliance, subsidiaryData);

    expect(report.compliance.auditTrail).toBe(compliance.auditTrail.lastAuditDate);
  });

  // Edge case that triggered the original bug: a compliance object missing auditTrail.
  it('throws a TypeError when compliance is missing auditTrail', () => {
    const company = resolveCompany('KII-9204715');
    const subsidiaryData = aggregateSubsidiaryMetrics(company);
    const complianceWithoutAuditTrail = {
      complianceTier: 'standard',
      reviewCycleDays: 90,
      hazmatRequired: true,
      nextReviewDate: new Date().toISOString(),
    };

    expect(() =>
      buildComplianceReport(company, complianceWithoutAuditTrail, subsidiaryData),
    ).toThrow(TypeError);
  });
});

describe('processSupplyInquiry', () => {
  it('resolves a compliance report for the supply inquiry endpoint', async () => {
    const report = await processSupplyInquiry({
      companyId: 'KII-9204715',
      sector: 'agriculture',
    });

    expect(report.companyId).toBe('KII-9204715');
    expect(report.compliance.auditTrail).toBeDefined();
    expect(report.requestId).toBeDefined();
  });
});

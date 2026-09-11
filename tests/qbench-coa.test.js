jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  generateCertificate,
  evaluateResults,
  SAMPLES,
  TEST_PANELS,
  SPEC_LIMITS,
} = require('../app/services/verticals/qbench');

describe('QBench certificate of analysis', () => {
  beforeEach(() => jest.clearAllMocks());

  test('issues a passing certificate for a panel with registered spec limits', async () => {
    const coa = await generateCertificate({ sampleId: 'S-260911-0038', reviewedBy: 'M. Okafor' });

    expect(coa.status).toBe('issued');
    expect(coa.disposition).toBe('pass');
    expect(coa.analytes).toHaveLength(3);
    expect(coa.signatory.name).toBe('Dr. Elena Marsh');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('flags an analyte over its action limit as a failing disposition', () => {
    const sample = {
      ...SAMPLES['S-260910-0117'],
      results: [{ analyte: 'E. coli', value: 12, unit: 'CFU/g' }],
    };
    const evaluation = evaluateResults(sample, TEST_PANELS.microbial);

    expect(evaluation.disposition).toBe('fail');
    expect(evaluation.analytes[0].status).toBe('fail');
  });

  test('applies the selected report template and rejects unknown ones', async () => {
    const standard = await generateCertificate({ sampleId: 'S-260911-0038', reviewedBy: 'M. Okafor' });
    expect(standard.reportFormat).toBe('standard');

    const regulatory = await generateCertificate({
      sampleId: 'S-260911-0038', reviewedBy: 'M. Okafor', reportFormat: 'regulatory',
    });
    expect(regulatory.reportFormat).toBe('regulatory');
    expect(regulatory.reportTemplate.regulatorySubmission).toBe(true);

    await expect(generateCertificate({ sampleId: 'S-260911-0038', reviewedBy: 'M. Okafor', reportFormat: 'docx' }))
      .rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
  });

  test('rejects unknown samples and missing reviewers with a ValidationError', async () => {
    await expect(generateCertificate({ sampleId: 'S-000', reviewedBy: 'x' }))
      .rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
    await expect(generateCertificate({ sampleId: 'S-260911-0038', reviewedBy: '' }))
      .rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
  });

  test('every onboarded test panel has registered spec limits', () => {
    // Documents the planted heavy_metals gap: this assertion is expected to
    // fail until the panel's specification limits are registered.
    const missing = Object.keys(TEST_PANELS).filter((code) => !SPEC_LIMITS[code]);
    expect(missing).toEqual(['heavy_metals']);
  });

  test('alerts Devin with the qbench customer when CoA generation throws', async () => {
    await expect(generateCertificate({ sampleId: 'S-260911-0042', reviewedBy: 'M. Okafor' }))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'qbench',
      service: 'customer-qbench-coa',
      culprit: 'app/services/verticals/qbench.js — evaluateResults',
    });
  });
});

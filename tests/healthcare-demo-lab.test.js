jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const payer = require('../app/services/verticals/ff0485e4');
const provider = require('../app/services/verticals/3a2b7a6d');
const pharma = require('../app/services/verticals/46ce04a1');
const lifeSciences = require('../app/services/verticals/27a970ec');
const thermoFisher = require('../app/services/verticals/bce3b3d2');
const cvsCopay = require('../app/services/verticals/1d54e3b4');
const lillyTrialLab = require('../app/services/verticals/fc0bd7f3');

const devin = { devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: '' };

const CASES = [
  {
    slug: 'ff0485e4', name: 'Payer prior authorization', run: payer.submitPriorAuth,
    failing: { memberId: 'SHP-448210', cpt: '72148', placeOfService: '22', attachedDocs: ['6 weeks conservative therapy', 'Neurologic deficit note'] },
    passing: { memberId: 'SHP-448210', cpt: '72148', placeOfService: '11', attachedDocs: ['6 weeks conservative therapy'] },
    message: "reading 'requiredDocs'", failureMetric: 'prior_auth.failure',
  },
  {
    slug: '3a2b7a6d', name: 'Provider appointment intake', run: provider.submitIntake,
    failing: { mrn: 'MRN-100482', clinicianId: 'LH-201', visitType: 'telehealth', slot: '2026-11-04T09:30', completedForms: [] },
    passing: { mrn: 'MRN-100482', clinicianId: 'LH-201', visitType: 'in-person', slot: '2026-11-04T09:30', completedForms: [] },
    message: "reading 'consents'", failureMetric: 'intake.failure',
  },
  {
    slug: '46ce04a1', name: 'Pharma copay savings card', run: pharma.calculateCopayBenefit,
    failing: { cardId: 'VLX-5520-1187', productId: 'VLR-90', insuranceOutOfPocket: 1350 },
    passing: { cardId: 'VLX-5520-1187', productId: 'VLR-30', insuranceOutOfPocket: 450 },
    message: "reading 'cardMax'", failureMetric: 'copay_card.failure',
  },
  {
    slug: '27a970ec', name: 'Life Sciences trial lab pipeline', run: lifeSciences.ingestBatch,
    failing: { siteId: 'SITE-104' },
    passing: { siteId: 'SITE-101' },
    message: "reading 'factor'", failureMetric: 'lab_pipeline.batch.failure',
  },
  {
    slug: 'bce3b3d2', name: 'Thermo Fisher (PPD) central lab pipeline', run: thermoFisher.ingestBatch,
    failing: { siteId: 'SITE-104' },
    passing: { siteId: 'SITE-101' },
    message: "reading 'factor'", failureMetric: 'lab_pipeline.batch.failure',
  },  {
    slug: '1d54e3b4', name: 'CVS Pharmacy copay savings card', run: cvsCopay.calculateCopayBenefit,
    failing: { cardId: 'VLX-5520-1187', productId: 'VLR-90', insuranceOutOfPocket: 1350, pharmacy: 'CVS Pharmacy #10247 — New York, NY' },
    passing: { cardId: 'VLX-5520-1187', productId: 'VLR-30', insuranceOutOfPocket: 450, pharmacy: 'CVS Pharmacy #10247 — New York, NY' },
    message: "reading 'cardMax'", failureMetric: 'copay_card.failure',
  },
  {
    slug: 'fc0bd7f3', name: 'Lilly clinical trial lab pipeline', run: lillyTrialLab.ingestBatch,
    failing: { siteId: 'SITE-104' },
    passing: { siteId: 'SITE-101' },
    message: "reading 'factor'", failureMetric: 'lab_pipeline.batch.failure',
  },
];

describe.each(CASES)('$name ($slug)', ({ slug, run, failing, passing, message, failureMetric }) => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('the default page action fails with a TypeError and raises an alert', async () => {
    await expect(run({ ...failing, ...devin })).rejects.toThrow(message);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(incrementMetric).toHaveBeenCalledWith(failureMetric, expect.any(Object));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe(slug);
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain(`app/services/verticals/${slug}.js`);
    expect(alert.devinOrgId).toBe('org-1');
  });

  test('the alternate path succeeds without alerting', async () => {
    const result = await run({ ...passing, ...devin });
    expect(result.success).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('invalid input is a 400-style ValidationError, not an alert', async () => {
    await expect(run({})).rejects.toMatchObject({ name: 'ValidationError' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

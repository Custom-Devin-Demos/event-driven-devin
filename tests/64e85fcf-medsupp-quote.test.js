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

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  runQuoteComparison,
  carriersAppointedIn,
  effectiveDateFor,
  zipInRatingArea,
  planFEligible,
  CARRIERS,
  RATE_FILINGS,
} = require('../app/services/verticals/64e85fcf');
const router = require('../app/routes/verticals/64e85fcf');

const baseRequest = {
  agentName: 'Danielle Whitaker',
  clientFirstName: 'Margaret',
  state: 'MO',
  zip: '64105',
  medicareEligibleDate: '2026-09-01',
  age: 65,
  gender: 'female',
  tobacco: false,
  plan: 'G',
  enrollmentWindow: 'open_enrollment',
  effectiveDate: 'next_month',
  devinUserId: 'user-1',
  devinOrgId: 'org-1',
  devinEmail: '',
};

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('Spring Venture Group SmartMatch Medicare Supplement quote (64e85fcf)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the newly appointed carrier is in the MO roster but has no MO rate filing', () => {
    expect(CARRIERS['car-hgl'].states).toContain('MO');
    expect(RATE_FILINGS['car-hgl'].MO).toBeUndefined();
    expect(carriersAppointedIn('MO').map((c) => c.carrierId)).toContain('car-hgl');
  });

  test('default Missouri Plan G comparison fails with a TypeError and raises a direct alert', async () => {
    await expect(runQuoteComparison(baseRequest)).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('64e85fcf');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('priceCarrierPlan');
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.devinOrgId).toBe('org-1');
    expect(alert.slackMemberId).toBe('U08S7AVJ478');
    expect(alert.slackMemberIdFallback).toBe('U08S7AVJ478');
  });

  test('leaves the on-call mention to the demo identity email when one is supplied', async () => {
    await expect(runQuoteComparison({ ...baseRequest, devinEmail: 'agent@devindemos.com' })).rejects.toThrow(TypeError);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe('U08S7AVJ478');
  });

  test('Kansas comparison prices every appointed carrier including the new one', async () => {
    const result = await runQuoteComparison({ ...baseRequest, state: 'KS', zip: '66210' });

    expect(result.success).toBe(true);
    expect(result.quotes.map((q) => q.carrierId).sort()).toEqual(['car-aet', 'car-cig', 'car-hgl', 'car-moo']);
    expect(result.quotes[0].monthly).toBeLessThanOrEqual(result.quotes[1].monthly);
    expect(result.summary.lowestCarrier).toBe('Heartland Guaranty Life');
    expect(result.enrollment.effectiveDate).toMatch(/^\d{4}-\d{2}-01$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('rating factors apply age, gender and tobacco loads to the filed base premium', async () => {
    const female65 = await runQuoteComparison({ ...baseRequest, state: 'TX', zip: '75201' });
    const male72Tobacco = await runQuoteComparison({ ...baseRequest, state: 'TX', zip: '75201', age: 72, gender: 'male', tobacco: true });

    const moo65 = female65.quotes.find((q) => q.carrierId === 'car-moo');
    const moo72 = male72Tobacco.quotes.find((q) => q.carrierId === 'car-moo');
    expect(moo65.monthly).toBe(RATE_FILINGS['car-moo'].TX.plans.G);
    expect(moo72.monthly).toBeCloseTo(RATE_FILINGS['car-moo'].TX.plans.G * 1.21 * 1.09 * 1.15, 1);
    expect(moo72.householdMonthly).toBeLessThan(moo72.monthly);
  });

  test('ZIPs must fall inside the rating area filed for the state', () => {
    expect(zipInRatingArea('KS', '66210')).toBe(true);
    expect(zipInRatingArea('KS', '33602')).toBe(false);
    expect(zipInRatingArea('MO', '64105')).toBe(true);
  });

  test('Plan F eligibility requires original Medicare eligibility before 2020', () => {
    expect(planFEligible('2019-06-01')).toBe(true);
    expect(planFEligible('2020-01-01')).toBe(false);
    expect(planFEligible('')).toBe(false);
  });

  test('effective date resolves to the first of the requested month', () => {
    const now = new Date('2026-09-22T18:00:00Z');
    expect(effectiveDateFor('next_month', now)).toBe('2026-10-01');
    expect(effectiveDateFor('following_month', now)).toBe('2026-11-01');
  });

  describe('route', () => {
    let server;

    beforeAll((done) => {
      const app = express();
      app.use(express.json());
      app.use(router);
      server = app.listen(0, done);
    });

    afterAll((done) => { server.close(done); });

    test('returns 500 with the TypeError for the default request', async () => {
      const res = await postJson(server, '/api/64e85fcf/quotes', baseRequest);
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.errorClass).toBe('TypeError');
      expect(res.body.code).toBe('QUOTE_COMPARISON_FAILED');
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid input with 400s without alerting', async () => {
      const cases = [
        { ...baseRequest, agentName: '' },
        { ...baseRequest, state: 'NY' },
        { ...baseRequest, zip: '1234' },
        { ...baseRequest, zip: '' },
        { ...baseRequest, state: 'KS', zip: '33602' },
        { ...baseRequest, medicareEligibleDate: 'yesterday' },
        { ...baseRequest, age: 40 },
        { ...baseRequest, plan: 'Z' },
        { ...baseRequest, state: 'FL', zip: '33602', plan: 'F' },
        { ...baseRequest, state: 'FL', zip: '33602', plan: 'F', medicareEligibleDate: '' },
        { ...baseRequest, enrollmentWindow: 'guaranteed_issue', plan: 'N' },
        { ...baseRequest, effectiveDate: 'tomorrow' },
      ];
      for (const body of cases) {
        const res = await postJson(server, '/api/64e85fcf/quotes', body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('returns the comparison for a state with complete filings', async () => {
      const res = await postJson(server, '/api/64e85fcf/quotes', { ...baseRequest, state: 'FL', zip: '33602' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.quotes).toHaveLength(4);
      expect(res.body.client.stateName).toBe('Florida');
    });

    test('quotes Plan F once pre-2020 Medicare eligibility is established', async () => {
      const res = await postJson(server, '/api/64e85fcf/quotes', {
        ...baseRequest, state: 'FL', zip: '33602', age: 74, plan: 'F', medicareEligibleDate: '2017-03-01',
      });
      expect(res.status).toBe(200);
      expect(res.body.plan.code).toBe('F');
      expect(res.body.client.medicareEligibleDate).toBe('2017-03-01');
    });
  });
});

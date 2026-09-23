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
  placeVialOrder,
  previousStrength,
  pharmacyFor,
  refillStatus,
  priceFill,
  estimatedDelivery,
  VIAL_CATALOG,
  SELF_PAY_PRICING,
  DISPENSING_PHARMACIES,
} = require('../app/services/verticals/eda0e2e5');
const router = require('../app/routes/verticals/eda0e2e5');

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const baseRequest = {
  patientFirstName: 'Jordan',
  prescriberName: 'Elena Ruiz, NP',
  rxNumber: 'RX-4471902',
  strengthMg: 12.5,
  fillType: 'dose_increase',
  priorDeliveryDate: isoDaysAgo(31),
  state: 'IN',
  zip: '46202',
  shipping: 'standard',
  devinUserId: 'user-1',
  devinOrgId: 'org-1',
  devinEmail: '',
};

function request(server, method, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('Lilly LillyDirect self-pay vial order (eda0e2e5)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the 12.5 mg and 15 mg vials are in the catalog but have no self-pay pricing', () => {
    expect(VIAL_CATALOG['12.5']).toBeDefined();
    expect(VIAL_CATALOG['15']).toBeDefined();
    expect(SELF_PAY_PRICING['12.5']).toBeUndefined();
    expect(SELF_PAY_PRICING['15']).toBeUndefined();
    expect(Object.keys(SELF_PAY_PRICING).sort()).toEqual(['10', '2.5', '5', '7.5']);
  });

  test('default 12.5 mg dose-increase order fails with a TypeError and raises a direct alert', async () => {
    await expect(placeVialOrder(baseRequest)).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('eda0e2e5');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('priceFill');
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.devinOrgId).toBe('org-1');
    expect(alert.slackMemberId).toBe('U08S7AVJ478');
    expect(alert.slackMemberIdFallback).toBe('U08S7AVJ478');
  });

  test('the 15 mg vial fails the same way', async () => {
    await expect(placeVialOrder({ ...baseRequest, strengthMg: 15, fillType: 'refill' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('leaves the on-call mention to the demo identity email when one is supplied', async () => {
    await expect(placeVialOrder({ ...baseRequest, devinEmail: 'patient@devindemos.com' })).rejects.toThrow(TypeError);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe('U08S7AVJ478');
  });

  test('a 10 mg dose increase is priced at the Journey price and routed to the state pharmacy', async () => {
    const result = await placeVialOrder({ ...baseRequest, strengthMg: 10 });

    expect(result.success).toBe(true);
    expect(result.orderId).toMatch(/^LD-[0-9A-F]{8}$/);
    expect(result.prescription.ndc).toBe(VIAL_CATALOG['10'].ndc);
    expect(result.fill.steppedUpFrom).toBe(7.5);
    expect(result.pricing.medicationPrice).toBe(499);
    expect(result.pricing.listPrice).toBe(699);
    expect(result.pricing.programSavings).toBe(200);
    expect(result.pricing.total).toBe(499);
    expect(result.fulfillment.pharmacyId).toBe('ph-ind');
    expect(result.fulfillment.nextRefillDue > result.fulfillment.estimatedDelivery).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a late 7.5 mg refill loses the Journey price; an on-time one keeps it', async () => {
    const late = await placeVialOrder({ ...baseRequest, strengthMg: 7.5, fillType: 'refill', priorDeliveryDate: isoDaysAgo(60) });
    expect(late.fill.withinRefillWindow).toBe(false);
    expect(late.pricing.programEligible).toBe(false);
    expect(late.pricing.medicationPrice).toBe(599);

    const onTime = await placeVialOrder({ ...baseRequest, strengthMg: 7.5, fillType: 'refill', priorDeliveryDate: isoDaysAgo(30) });
    expect(onTime.fill.withinRefillWindow).toBe(true);
    expect(onTime.pricing.medicationPrice).toBe(499);
  });

  test('flat-price strengths ignore the refill window and expedited shipping adds its fee', async () => {
    const result = await placeVialOrder({ ...baseRequest, strengthMg: 5, fillType: 'refill', priorDeliveryDate: isoDaysAgo(90), shipping: 'expedited', state: 'TX', zip: '75201' });
    expect(result.pricing.medicationPrice).toBe(499);
    expect(result.pricing.shippingFee).toBe(24);
    expect(result.pricing.total).toBe(523);
    expect(result.fulfillment.pharmacyId).toBe('ph-phx');
  });

  test('priceFill resolves every priced strength and crashes on the unpriced ones', () => {
    const status = { daysSincePrior: null, withinWindow: true };
    for (const key of Object.keys(SELF_PAY_PRICING)) {
      expect(priceFill(VIAL_CATALOG[key], 'first_fill', status, 'standard').journeyPrice).toBe(SELF_PAY_PRICING[key].journeyPrice);
    }
    expect(() => priceFill(VIAL_CATALOG['12.5'], 'first_fill', status, 'standard')).toThrow(TypeError);
  });

  test('titration steps resolve the prior strength', () => {
    expect(previousStrength(12.5)).toBe(10);
    expect(previousStrength(5)).toBe(2.5);
    expect(previousStrength(2.5)).toBeNull();
  });

  test('pharmacies cover their ship-to states and reject others', () => {
    expect(pharmacyFor('NC').pharmacyId).toBe('ph-rdu');
    expect(pharmacyFor('IN').name).toBe(DISPENSING_PHARMACIES['ph-ind'].name);
    expect(() => pharmacyFor('HI')).toThrow(/does not ship/);
  });

  test('refill status only counts days for refills', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    expect(refillStatus('refill', '2026-08-20', now)).toEqual({ daysSincePrior: 33, withinWindow: true });
    expect(refillStatus('refill', '2026-07-01', now)).toEqual({ daysSincePrior: 83, withinWindow: false });
    expect(refillStatus('dose_increase', '2026-07-01', now)).toEqual({ daysSincePrior: null, withinWindow: true });
  });

  test('delivery estimates respect the pharmacy cutoff and transit time', () => {
    const pharmacy = { ...DISPENSING_PHARMACIES['ph-ind'], pharmacyId: 'ph-ind' };
    expect(estimatedDelivery(pharmacy, 'standard', new Date('2026-09-22T10:00:00Z'))).toEqual({ shipDate: '2026-09-22', deliveryDate: '2026-09-24' });
    expect(estimatedDelivery(pharmacy, 'expedited', new Date('2026-09-22T23:00:00Z'))).toEqual({ shipDate: '2026-09-23', deliveryDate: '2026-09-24' });
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

    test('catalog lists every vial and flags the unpriced ones', async () => {
      const res = await request(server, 'GET', '/api/eda0e2e5/catalog');
      expect(res.status).toBe(200);
      expect(res.body.vials.map((v) => v.strengthMg)).toEqual([2.5, 5, 7.5, 10, 12.5, 15]);
      expect(res.body.vials.find((v) => v.strengthMg === 10).pricing.journeyPrice).toBe(499);
      expect(res.body.vials.find((v) => v.strengthMg === 12.5).pricing).toBeNull();
      expect(res.body.shipToStates).toContain('IN');
    });

    test('returns 500 with the TypeError for the default request', async () => {
      const res = await request(server, 'POST', '/api/eda0e2e5/orders', baseRequest);
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.errorClass).toBe('TypeError');
      expect(res.body.code).toBe('VIAL_ORDER_FAILED');
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid input with 400s without alerting', async () => {
      const cases = [
        { ...baseRequest, patientFirstName: '' },
        { ...baseRequest, prescriberName: '' },
        { ...baseRequest, rxNumber: '4471902' },
        { ...baseRequest, strengthMg: 20 },
        { ...baseRequest, strengthMg: 'twelve' },
        { ...baseRequest, fillType: 'sample' },
        { ...baseRequest, strengthMg: 2.5, fillType: 'dose_increase' },
        { ...baseRequest, fillType: 'refill', priorDeliveryDate: '' },
        { ...baseRequest, fillType: 'refill', priorDeliveryDate: '2026-02-30' },
        { ...baseRequest, fillType: 'refill', priorDeliveryDate: isoDaysAgo(-3) },
        { ...baseRequest, fillType: 'refill', priorDeliveryDate: isoDaysAgo(200) },
        { ...baseRequest, state: 'HI' },
        { ...baseRequest, state: 'in' },
        { ...baseRequest, zip: '4620' },
        { ...baseRequest, shipping: 'drone' },
      ];
      for (const body of cases) {
        const res = await request(server, 'POST', '/api/eda0e2e5/orders', body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('accepts strengths sent as strings and confirms a priced order', async () => {
      const res = await request(server, 'POST', '/api/eda0e2e5/orders', { ...baseRequest, strengthMg: '5', fillType: 'first_fill', priorDeliveryDate: '' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prescription.strengthMg).toBe(5);
      expect(res.body.fill.type).toBe('First fill');
      expect(res.body.pricing.total).toBe(499);
      expect(res.body.status).toBe('order_confirmed');
    });
  });
});

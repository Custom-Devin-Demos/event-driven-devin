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
const {
  estimateShipping, applyPromo, checkout,
} = require('../app/services/verticals/mms');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { listAliases, getCustomerConfig } = require('../config/customers');

const ITEMS = [{ sku: '701130-90450', qty: 20 }];
const OCT_8 = new Date('2026-10-08T15:00:00Z');

describe("M&M'S cart (mms)", () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('is registered at /m&m with its own customer config', () => {
    expect(listAliases()['m&m']).toBe('mms');
    expect(getCustomerConfig('mms').customer).toBe('mms');
  });

  test('shipping estimate for 11249 matches the cart screenshot', () => {
    const result = estimateShipping({ items: ITEMS, zip: '11249' }, OCT_8);
    expect(result.subtotal).toBe(55);
    expect(result.awayFromFreeShipping).toBe(20);
    expect(result.options).toEqual([
      { id: 'standard', label: 'Standard shipping', price: 9.99, estimatedDelivery: 'Saturday, October 17' },
      { id: 'express', label: 'Express shipping', price: 29.99, estimatedDelivery: 'Wednesday, October 14' },
    ]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('validation problems are 400s and never alert', async () => {
    expect(() => estimateShipping({ items: ITEMS, zip: '1124' })).toThrow('please input 5 digits');
    expect(() => estimateShipping({ items: [{ sku: '701130-90450', qty: 22 }], zip: '11249' }))
      .toThrow('increments of 5');
    await expect(applyPromo({ items: ITEMS, code: 'NOPE' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(checkout({ items: ITEMS, zip: '11249' })).rejects.toMatchObject({ code: 'SHIPPING_METHOD_REQUIRED' });
    await expect(checkout({ items: ITEMS, zip: '99999', shippingMethod: 'standard' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_ZIP' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('checkout succeeds for a destination with a personalized-confectionery tax rate', async () => {
    const result = await checkout({ items: ITEMS, zip: '07030', shippingMethod: 'standard' });
    expect(result).toMatchObject({
      success: true, subtotal: 55, shipping: 9.99, salesTax: 3.64, total: 68.63,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('checkout to Brooklyn (11249) fails with a TypeError and raises one alert', async () => {
    await expect(checkout({
      items: ITEMS, zip: '11249', shippingMethod: 'standard', devinEmail: 'presenter@devindemos.com',
    })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ alert_path: 'instant', ship_state: 'NY' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: 'mms', service: 'mms-checkout', errorType: 'TypeError', devinEmail: 'presenter@devindemos.com',
    });
    expect(alert.culprit).toContain('calculateSalesTax');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('/m&m');
  });

  test('FAVORS10 applies; SWEET15 fails with a TypeError and raises one alert', async () => {
    await expect(applyPromo({ items: ITEMS, code: 'favors10' })).resolves.toMatchObject({ discount: 5.5 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();

    await expect(applyPromo({ items: ITEMS, code: 'SWEET15' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: 'mms', service: 'mms-promotions', errorType: 'TypeError' });
    expect(alert.culprit).toContain('computeDiscount');
  });

  test('the Sentry webhook treats M&M\'S events as already alerted', () => {
    expect(isInstantPathEvent({ tags: [['alert_path', 'instant']], culprit: '' })).toBe(true);
    expect(isInstantPathEvent({ tags: [], culprit: 'POST /api/mms/checkout' })).toBe(true);
    expect(isInstantPathEvent({ tags: [], culprit: 'app/services/verticals/mms.js — computeDiscount' })).toBe(true);
    expect(isInstantPathEvent({ tags: [], culprit: 'POST /api/coppel/checkout' })).toBe(false);
  });
});

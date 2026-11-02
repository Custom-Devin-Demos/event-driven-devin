jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'mock' })),
}));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../app/services/devin-session');
const svc = require('../app/services/verticals/walmart');
const { buildAlertBlocks } = require('../app/services/slack');
const customer = require('../config/customers/walmart');

const TURKEY = '996282298';
const STUFFING = '10313598';
const POTATOES = '10447837';
const WINE = '191420088';

describe('Walmart Holiday Food checkout (walmart)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('catalog carries the three carousels and one weighted item', () => {
    expect(svc.SHELVES.map((s) => s.key)).toEqual(['staples', 'friendsgiving', 'cleanup']);
    svc.SHELVES.forEach((s) => expect(svc.CATALOG.some((p) => p.shelf === s.key)).toBe(true));
    const turkey = svc.CATALOG.find((p) => p.id === TURKEY);
    expect(turkey.salesUnitType).toBe('WEIGHT');
    expect(turkey.avgWeightLb).toBe(14.2);
    expect(svc.CATALOG.filter((p) => p.salesUnitType === 'WEIGHT')).toHaveLength(1);
    expect(svc.UNIT_PRICING.WEIGHT).toBeUndefined();
    svc.CATALOG.forEach((p) => expect(p.image).toMatch(/^https:\/\/i5\.walmartimages\.com\//));
  });

  test('fixed-price pickup cart places successfully with savings and tax', async () => {
    const order = await svc.placeOrder({ items: [{ id: STUFFING, qty: 2 }, { id: POTATOES }], fulfillment: 'pickup' });
    expect(order.success).toBe(true);
    expect(order.orderId).toMatch(/^WM-/);
    expect(order.fulfillment).toEqual({ type: 'pickup', label: 'Pickup', slot: 'Today, 5pm\u20136pm' });
    expect(order.subtotal).toBe(6.23);
    expect(order.savings).toBe(1.88);
    expect(order.fee).toBe(0);
    expect(order.tax).toBe(0.51);
    expect(order.total).toBe(6.74);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('delivery below the free-delivery minimum adds the delivery fee; Walmart+ waives it', async () => {
    const paid = await svc.placeOrder({ items: [{ id: WINE }], fulfillment: 'delivery' });
    expect(paid.fee).toBe(svc.DELIVERY_FEE);
    const wplus = await svc.placeOrder({ items: [{ id: WINE }], fulfillment: 'delivery', wplus: true });
    expect(wplus.fee).toBe(0);
  });

  test('validation errors are 400s and do not alert', async () => {
    await expect(svc.placeOrder({ items: [] })).rejects.toMatchObject({ status: 400, code: 'EMPTY_CART' });
    await expect(svc.placeOrder({ items: [{ id: 'nope' }] })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_PRODUCT' });
    await expect(svc.placeOrder({ items: [{ id: STUFFING, qty: 99 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_QTY' });
    await expect(svc.placeOrder({ items: [{ id: STUFFING }], fulfillment: 'drone' })).rejects.toMatchObject({ status: 400, code: 'BAD_FULFILLMENT' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a cart with the weighted turkey fails in priceLine and raises the instant alert with a Quantum Metric signal', async () => {
    let caught;
    try {
      await svc.placeOrder({
        items: [{ id: TURKEY }, { id: STUFFING, qty: 2 }],
        fulfillment: 'delivery',
        devinUserId: 'user-1',
        devinOrgId: 'org-1',
        devinEmail: 'marcel@devindemos.com',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toBe("Cannot read properties of undefined (reading 'estimateLb')");
    expect(caught.status).toBe(500);
    expect(caught.quantumMetric.sessionId).toMatch(/^qm-/);
    expect(caught.quantumMetric.replayUrl).toContain('walmart.quantummetric.com');

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, sentryCtx] = Sentry.captureException.mock.calls[0];
    expect(sentryCtx.tags).toMatchObject({ alert_path: 'instant', customer: 'walmart', experience_monitor: 'quantum-metric' });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: 'walmart',
      errorType: 'TypeError',
      culprit: svc.CULPRIT || 'app/services/verticals/walmart.js \u2014 priceLine',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'marcel@devindemos.com',
    });
    expect(alert.quantumMetric).toMatchObject({
      source: 'Quantum Metric',
      rageClickTarget: 'Continue to checkout',
      affectedSessions: '1,284',
    });
    expect(alert.promptAppendix).toContain('Quantum Metric session replay');
  });

  test('Slack card renders the Quantum Metric section and replay button', () => {
    const qm = svc.buildQuantumMetricSignal('WM-TEST-1234');
    const blocks = buildAlertBlocks({
      issueTitle: 'TypeError: boom', errorType: 'TypeError', errorValue: 'boom', service: 'walmart-holiday-food-checkout',
      verticalLabel: 'Walmart Holiday Food Checkout', customer: 'walmart', quantumMetric: qm, issueUrl: 'https://sentry.io/x',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('Experience signal — Quantum Metric');
    expect(text).toContain('1,284');
    expect(text).toContain(qm.replayUrl);
    const buttons = blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text);
    expect(buttons.some((b) => b.includes('Quantum Metric'))).toBe(true);
  });

  test('Teams field card repeats the Quantum Metric signal in the top-level footer', () => {
    const { buildTeamsAlertCardForAlert } = require('../app/services/devin-session');
    const qm = svc.buildQuantumMetricSignal('WM-TEST-1234');
    const card = buildTeamsAlertCardForAlert({
      issueTitle: 'TypeError: boom', errorType: 'TypeError', errorValue: 'boom', service: 'walmart-holiday-food-checkout',
      verticalLabel: 'Walmart Holiday Food Checkout', customer: 'walmart', quantumMetric: qm, issueUrl: 'https://sentry.io/x',
    });
    const footer = JSON.stringify(card.body.filter((b) => b.type === 'TextBlock'));
    expect(footer).toContain(qm.sessionId);
    expect(footer).toContain(qm.replayUrl);
    expect(footer).toContain('1,284');
  });

  test('customer config is API-triggered', () => {
    expect(customer.triggerMode).toBe('api');
    expect(customer.label).toContain('Walmart');
  });
});

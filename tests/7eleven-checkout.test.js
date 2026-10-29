jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'mock' })),
}));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../app/services/devin-session');
const svc = require('../app/services/verticals/7eleven');
const { buildTeamsCloudWatchAlarmCard } = require('../app/services/teams');
const { alertStrings } = require('../app/services/alert-locale');
const customer = require('../config/customers/7eleven');

const MONSTER = '246630-0-1';
const PIZZA = '178322-2-6-2';
const HALF_BAKED = '190395-0-1';

describe('7NOW checkout (7eleven)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('catalog exposes the home shelves and a frozen ice-cream pint', () => {
    expect(svc.SHELVES.map((s) => s.title)).toEqual(['Late Night Essentials', 'Hot Bites', 'Wickedly Delicious Pizza']);
    svc.SHELVES.forEach((s) => s.ids.forEach((id) => expect(svc.CATALOG.find((p) => p.id === id)).toBeTruthy()));
    expect(svc.CATALOG.find((p) => p.id === HALF_BAKED).temp).toBe('frozen');
    expect(svc.HANDLING_RULES.frozen).toBeUndefined();
    expect(svc.CATEGORIES).toHaveLength(10);
  });

  test('hot + chilled cart places successfully with fees', async () => {
    const order = await svc.placeOrder({ items: [{ id: MONSTER, qty: 2 }, { id: PIZZA }], address: '1 Main St, Irving, TX' });
    expect(order.success).toBe(true);
    expect(order.orderId).toMatch(/^7N-/);
    expect(order.bags).toEqual(['Cooler bag', 'Hot food bag']);
    expect(order.subtotal).toBe(16.17);
    expect(order.smallBasketFee).toBe(0);
    expect(order.total).toBe(21.3);
    expect(order.etaMinutes).toBe(25);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('fees are rounded to cents independently (parity with the page)', async () => {
    const order = await svc.placeOrder({ items: [{ id: MONSTER, qty: 3 }], address: '1 Main St, Irving, TX' });
    expect(order.subtotal).toBe(12.27);
    expect(order.serviceFee).toBe(0.61);
    expect(order.tax).toBe(1.01);
    expect(order.total).toBe(16.88);
  });

  test('small baskets get the small basket fee', async () => {
    const order = await svc.placeOrder({ items: [{ id: '140370-0-1' }], address: '1 Main St, Irving, TX' });
    expect(order.smallBasketFee).toBe(svc.SMALL_BASKET_FEE);
  });

  test('validation errors are 400s and do not alert', async () => {
    await expect(svc.placeOrder({ items: [] })).rejects.toMatchObject({ status: 400, code: 'EMPTY_CART' });
    await expect(svc.placeOrder({ items: [{ id: 'nope' }] })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_PRODUCT' });
    await expect(svc.placeOrder({ items: [{ id: MONSTER, qty: 99 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_QTY' });
    await expect(svc.placeOrder({ items: [{ id: MONSTER, qty: 0 }] })).rejects.toMatchObject({ status: 400, code: 'BAD_QTY' });
    await expect(svc.placeOrder({ items: [{ id: MONSTER }] })).rejects.toMatchObject({ status: 400, code: 'ADDRESS_REQUIRED' });
    await expect(svc.placeOrder({ items: [{ id: MONSTER }], address: ' Add Address ' })).rejects.toMatchObject({ status: 400, code: 'ADDRESS_REQUIRED' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a frozen pint throws the planted TypeError and raises a CloudWatch-flavoured instant alert', async () => {
    const ids = { devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'demo@devindemos.com' };
    await expect(svc.placeOrder({ items: [{ id: MONSTER }, { id: HALF_BAKED }], address: '1 Main St, Irving, TX', ...ids }))
      .rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      route: svc.ROUTE, service: svc.SERVICE, customer: '7eleven', monitor: 'cloudwatch', alert_path: 'instant',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: '7eleven',
      locale: 'en-cloudwatch',
      errorType: 'TypeError',
      service: svc.SERVICE,
      verticalLabel: '7NOW Checkout',
      ...ids,
    });
    expect(alert.issueTitle).toMatch(/^TypeError: Cannot read properties of undefined \(reading 'bagType'\)/);
    expect(alert.culprit).toContain('packLine');
    expect(alert.issueUrl).toContain('console.aws.amazon.com/cloudwatch');
    expect(alert.issueUrl).not.toMatch(/sentry/i);
    expect(alert.cloudwatch).toMatchObject({
      alarmName: svc.ALARM_NAME,
      namespace: '7NOW/CheckoutAPI',
      metricName: '5XXError',
      region: 'us-east-1',
      dimensions: { ServiceName: svc.SERVICE, Environment: 'prod' },
    });
    expect(alert.cloudwatch.reason).toMatch(/^Threshold Crossed: 1 datapoint/);
    expect(alert.promptAppendix).toContain('app/services/verticals/7eleven.js');
  });
});

describe('CloudWatch alert vocabulary and Teams alarm card', () => {
  test('customer config selects the en-cloudwatch strings', () => {
    expect(customer.locale).toBe('en-cloudwatch');
    const t = alertStrings({ customerConfig: customer });
    expect(t.header('7NOW Checkout')).toBe('AWS CloudWatch Alarm — 7NOW Checkout Error');
    expect(t.viewSentry).toBe('View in CloudWatch');
    expect(t.sentryIssue).toBe('CloudWatch Alarm');
    expect(Object.values(t).filter((v) => typeof v === 'string').join(' ')).not.toMatch(/sentry/i);
  });

  test('Teams card is laid out like an SNS CloudWatch ALARM notification', () => {
    const cw = svc.buildAlarm(Date.UTC(2026, 9, 29, 5, 43, 12));
    const card = buildTeamsCloudWatchAlarmCard({
      cw,
      logEvent: "[Error] TypeError: Cannot read properties of undefined (reading 'bagType')",
      instructions: 'Fix it',
      actions: [
        { title: 'Watch Devin', url: 'https://app.devin.ai/automations/x' },
        { title: 'View in CloudWatch', url: cw.alarmUrl },
        { title: 'View logs in CloudWatch Logs', url: cw.logsUrl },
        { title: 'skipped', url: undefined },
      ],
      footer: 'Service: customer-7eleven-checkout',
    });
    expect(card.type).toBe('AdaptiveCard');
    const text = JSON.stringify(card);
    expect(card.body[0].text).toBe('\u{1F534} ALARM: "7now-checkout-api-5xx-errors" in US East (N. Virginia)');
    expect(card.body[0].color).toBe('Attention');
    expect(card.body[1].text).toContain('has entered the ALARM state, because "Threshold Crossed: 1 datapoint [1.0 (29/10/26 05:43:00)]');
    ['Alarm Details', 'Threshold', 'Monitored Metric', 'State Change Actions'].forEach((h) => {
      expect(card.body.find((b) => b.type === 'TextBlock' && b.weight === 'Bolder' && b.text === h)).toBeTruthy();
    });
    const facts = card.body.filter((b) => b.type === 'FactSet').flatMap((b) => b.facts);
    const fact = (title) => facts.find((f) => f.title === title).value;
    expect(fact('State Change')).toBe('OK -> ALARM');
    expect(fact('Alarm Arn')).toBe('arn:aws:cloudwatch:us-east-1:735612984401:alarm:7now-checkout-api-5xx-errors');
    expect(fact('MetricNamespace')).toBe('7NOW/CheckoutAPI');
    expect(fact('Dimensions')).toContain('[ServiceName = customer-7eleven-checkout]');
    expect(fact('ALARM')).toBe('[arn:aws:sns:us-east-1:735612984401:7now-oncall-alerts]');
    expect(text).toContain('GreaterThanOrEqualToThreshold 1.0 for at least 1 of 1 datapoints within 60 seconds');
    const mono = card.body.find((b) => b.fontType === 'Monospace');
    expect(mono.text).toContain("reading 'bagType'");
    const actions = card.body.find((b) => b.type === 'ActionSet').actions.map((a) => a.title);
    expect(actions).toEqual(['Watch Devin', 'View in CloudWatch', 'View logs in CloudWatch Logs']);
    expect(text).not.toMatch(/sentry/i);
  });
});

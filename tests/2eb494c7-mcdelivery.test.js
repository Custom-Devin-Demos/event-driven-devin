jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  placeOrder, buildCartLines, computeFees, resolveHandoffProtocol, buildDasherInstructions,
  DROP_OFF_OPTIONS, HANDOFF_PROTOCOLS, MENU, DELIVERY_FEE,
} = require('../app/services/verticals/2eb494c7');

const BIG_MAC_MEAL = { sku: 'big-mac-meal', qty: 1, modifiers: { size: 'medium', side: 'fries', drink: 'coke' } };

describe('McDelivery (2eb494c7) — cart and pricing', () => {
  test('menu carries the captured Big Mac Meal price', () => {
    const item = MENU.find((m) => m.sku === 'big-mac-meal');
    expect(item.price).toBe(12.59);
    expect(item.meal).toBe(true);
  });

  test('meal modifiers apply size upcharge and produce the modifier summary', () => {
    const [line] = buildCartLines([{ sku: 'big-mac-meal', qty: 2, modifiers: { size: 'large', side: 'fries', drink: 'sprite' } }]);
    expect(line.unitPrice).toBe(13.79);
    expect(line.lineTotal).toBe(27.58);
    expect(line.modifiers).toEqual(['Large', 'French Fries', 'Sprite\u00ae']);
  });

  test('non-meal items ignore modifiers', () => {
    const [line] = buildCartLines([{ sku: 'fries', qty: 1, modifiers: { size: 'large' } }]);
    expect(line.unitPrice).toBe(4.69);
    expect(line.modifiers).toEqual([]);
  });

  test('rejects unknown items and bad quantities', () => {
    expect(() => buildCartLines([{ sku: 'mcrib', qty: 1 }])).toThrow(expect.objectContaining({ code: 'UNKNOWN_ITEM', status: 400 }));
    expect(() => buildCartLines([{ sku: 'fries', qty: 0 }])).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(() => buildCartLines([{ sku: 'fries', qty: 99 }])).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
  });

  test('fees follow the captured checkout: $2.99 delivery, service fee, tax', () => {
    const fees = computeFees(12.59);
    expect(fees.deliveryFee).toBe(DELIVERY_FEE);
    expect(fees.serviceFee).toBe(1.51);
    expect(fees.tax).toBeGreaterThan(1.9);
    expect(fees.tax).toBeLessThan(2.1);
  });
});

describe('McDelivery (2eb494c7) — Dasher handoff protocol', () => {
  test('every drop-off option shown to the customer has a Dasher handoff protocol', () => {
    const missing = Object.keys(DROP_OFF_OPTIONS).filter((code) => !HANDOFF_PROTOCOLS[code]);
    // Planted defect: the default contactless option has no protocol entry.
    expect(missing).toEqual(['leave_at_door']);
  });

  test('resolveHandoffProtocol returns undefined for the default drop-off', () => {
    expect(resolveHandoffProtocol(DROP_OFF_OPTIONS.leave_at_door)).toBeUndefined();
    expect(resolveHandoffProtocol(DROP_OFF_OPTIONS.hand_it_to_me)).toBeDefined();
  });

  test('buildDasherInstructions works for hand_it_to_me', () => {
    const card = buildDasherInstructions(DROP_OFF_OPTIONS.hand_it_to_me, '233 S Wacker Dr', 'Ring twice');
    expect(card.photoRequired).toBe(false);
    expect(card.instruction).toMatch(/Ring twice/);
  });
});

describe('McDelivery (2eb494c7) — placeOrder', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('validation failures are 400s and do not alert', async () => {
    await expect(placeOrder({ items: [] })).rejects.toMatchObject({ code: 'EMPTY_CART', status: 400 });
    await expect(placeOrder({ items: [BIG_MAC_MEAL], tip: -1 })).rejects.toMatchObject({ code: 'INVALID_TIP', status: 400 });
    await expect(placeOrder({ items: [BIG_MAC_MEAL], dropOff: 'drone' })).rejects.toMatchObject({ code: 'DROP_OFF_OPTION', status: 400 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('"Hand it to me" orders succeed with the captured totals', async () => {
    const order = await placeOrder({ items: [BIG_MAC_MEAL], dropOff: 'hand_it_to_me', tip: 3.75 });
    expect(order.status).toBe('confirmed');
    expect(order.subtotal).toBe(12.59);
    expect(order.deliveryFee).toBe(2.99);
    expect(order.serviceFee).toBe(1.51);
    expect(order.tip).toBe(3.75);
    expect(order.total).toBeCloseTo(12.59 + 2.99 + 1.51 + order.tax + 3.75, 2);
    expect(order.delivery.dasher.dropOff).toBe('Hand it to me');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('default "Leave it at my door" order throws a TypeError and triggers the Devin alert', async () => {
    const attempt = placeOrder({
      items: [BIG_MAC_MEAL],
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'demo@example.com',
    });
    await expect(attempt).rejects.toBeInstanceOf(TypeError);
    await expect(attempt).rejects.toThrow(/photoRequired/);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.customer).toBe('2eb494c7');
    expect(payload.issueTitle).toMatch(/^TypeError: /);
    expect(payload.verticalLabel).toBe("McDonald's McDelivery");
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.devinEmail).toBe('demo@example.com');
    expect(payload.slackMemberId).toBe('');
    expect(payload.slackMemberIdFallback).toBeTruthy();
    expect(payload.tags).toEqual(expect.arrayContaining([{ key: 'route', value: '/api/2eb494c7/order' }]));
  });

  test('the Sentry webhook treats McDelivery events as already alerted', async () => {
    await expect(placeOrder({ items: [BIG_MAC_MEAL] })).rejects.toBeInstanceOf(TypeError);
    const captured = Sentry.captureException.mock.calls.at(-1)[1];
    expect(captured.tags.alert_path).toBe('instant');

    expect(isInstantPathEvent({
      tags: Object.entries(captured.tags),
      culprit: '',
    })).toBe(true);
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/2eb494c7.js — buildDasherInstructions',
    })).toBe(true);
  });

  test('scheduled orders also hit the defect', async () => {
    await expect(placeOrder({ items: [BIG_MAC_MEAL], schedule: '2026-09-22T19:15' })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });
});

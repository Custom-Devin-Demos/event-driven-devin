/* global beforeEach, describe, expect, jest, test */
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({ triggered: true }),
}));
jest.mock('../app/services/security-remediation-session', () => ({
  scheduleSecuritySession: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { scheduleSecuritySession } = require('../app/services/security-remediation-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  placeOrder,
  getStorefront,
  SECURITY_SESSION_DELAY_MS,
} = require('../app/services/verticals/f2f40117');

// The storefront's pre-filled order: Prairie Cup rivalry game, Section 108 Champions
// Club Sideline, 2 adult, mobile delivery, $100 Thunderhawk Athletic Fund gift.
const defaultOrder = {
  eventId: 'FB26-RIV',
  sectionId: '108',
  priceType: 'adult',
  quantity: 2,
  deliveryMethod: 'mobile',
  donationAmount: 100,
  accountId: 'CPS-4471028',
  paymentMethodId: 'pm_visa_4421',
  channel: 'web',
  devinUserId: 'user-123',
  devinOrgId: 'org-123',
  devinEmail: 'presenter@example.com',
};

describe('Learfield / Paciolan game-day ticketing (f2f40117)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    scheduleSecuritySession.mockClear();
    Sentry.captureException.mockClear();
  });

  test('default Champions Club order fails on the unregistered priority release window', async () => {
    await expect(placeOrder(defaultOrder)).rejects.toThrow(
      "Cannot read properties of undefined (reading 'pointsFloor')",
    );

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'f2f40117',
        skipVulnerablePr: true,
        errorType: 'TypeError',
        culprit: 'app/services/verticals/f2f40117.js — allocatePrioritySeats',
        devinUserId: 'user-123',
        devinOrgId: 'org-123',
        devinEmail: 'presenter@example.com',
      }),
    );
    expect(scheduleSecuritySession).toHaveBeenCalledWith({
      customer: 'f2f40117', devinUserId: 'user-123', devinOrgId: 'org-123', delayMs: SECURITY_SESSION_DELAY_MS,
    });
    expect(SECURITY_SESSION_DELAY_MS).toBe(60 * 1000);
  });

  test('tags the Sentry event so the issue webhook does not alert a second time', async () => {
    await expect(placeOrder(defaultOrder)).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ alert_path: 'instant', route: '/api/f2f40117/orders', sectionId: '108' }),
      }),
    );
  });

  test('webhook treats f2f40117 events as already alerted (slash and dotted culprits)', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/f2f40117.js — allocatePrioritySeats',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: 'allocatePrioritySeats(app.services.verticals.f2f40117)',
      tags: [],
    })).toBe(true);
  });

  test.each([
    ['215', 95, 4],
    ['320', 55, 4],
  ])('section %s completes with seats, mobile delivery and a TAF gift receipt', async (sectionId, unitPrice, facilityFee) => {
    const order = await placeOrder({ ...defaultOrder, sectionId });

    expect(order).toMatchObject({
      success: true,
      status: 'confirmed',
      quantity: 2,
      unitPrice,
      delivery: { deliveryMethodId: 'mobile' },
      donation: { amount: 100, fund: 'Thunderhawk Athletic Fund' },
      totals: {
        ticketSubtotal: unitPrice * 2,
        facilityFees: facilityFee * 2,
        orderFee: 7.5,
        donation: 100,
        orderTotal: unitPrice * 2 + facilityFee * 2 + 7.5 + 100,
      },
    });
    expect(order.orderNumber).toMatch(/^CPS-\d{9}$/);
    expect(order.seats).toHaveLength(2);
    expect(order.seats.every((seat) => seat.section === sectionId)).toBe(true);
    expect(order.account.priorityPointsEarned).toBe(5);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(scheduleSecuritySession).not.toHaveBeenCalled();
  });

  test('youth pricing and no gift in the end zone', async () => {
    const order = await placeOrder({ ...defaultOrder, sectionId: '320', priceType: 'youth', quantity: 4, donationAmount: 0 });
    expect(order.totals).toEqual({
      ticketSubtotal: 120, facilityFees: 16, orderFee: 7.5, deliveryFee: 0, donation: 0, orderTotal: 143.5,
    });
    expect(order.donation).toBeNull();
  });

  test.each([
    [{ sectionId: '999' }, 'UNKNOWN_SECTION'],
    [{ quantity: 9 }, 'INVALID_QUANTITY'],
    [{ deliveryMethod: 'carrier_pigeon' }, 'INVALID_DELIVERY_METHOD'],
    [{ donationAmount: -5 }, 'INVALID_DONATION'],
    [{ sectionId: '101' }, 'PRIORITY_HOLD_NOT_MET'],
    [{ sectionId: '215', quantity: 7 }, 'PRIORITY_LIMIT_EXCEEDED'],
  ])('rejects %j with a 400 ValidationError and no alert', async (overrides, code) => {
    await expect(placeOrder({ ...defaultOrder, ...overrides })).rejects.toMatchObject({
      name: 'ValidationError', statusCode: 400, code,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('storefront exposes the signed-in donor without payment-method internals leaking', () => {
    const storefront = getStorefront();
    expect(storefront.account).toMatchObject({ accountId: 'CPS-4471028', donorTierLabel: 'Champions Circle', priorityPoints: 2860 });
    expect(storefront.sections.map((s) => s.sectionId)).toEqual(['101', '108', '215', '320']);
    expect(storefront.events[0].eventId).toBe('FB26-RIV');
  });
});

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { confirmCheckout, buildPaymentPlan, getTenant, TENANTS, INSTALMENT_PLANS } = require('../app/services/verticals/c45a2e16');
const { createSessionAndAlert } = require('../app/services/devin-session');

describe('checkout plan tenants', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
  });

  it('gives every tenant its own unregistered Pay in 24 schedule so one fix cannot resolve another', () => {
    const keys = Object.values(TENANTS).map((tenant) => tenant.planCodes.pay_in_24);
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((key) => expect(INSTALMENT_PLANS[key]).toBeUndefined());
  });

  it('rejects an unknown or missing tenant as a 400 rather than serving a shared demo', async () => {
    await expect(confirmCheckout({ tenant: 'nope', plan: 'pay_in_4' }))
      .rejects.toMatchObject({ name: 'ValidationError', code: 'UNKNOWN_TENANT', statusCode: 400 });
    await expect(confirmCheckout({ plan: 'pay_in_4' })).rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(getTenant('')).toBeUndefined();
    expect(getTenant('NOUF')).toBe(TENANTS.nouf);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('rejects an unknown plan or order as a 400 without alerting', async () => {
    for (const plan of ['', 'pay_in_36', 'pay_in_24_nouf', '__proto__']) {
      await expect(confirmCheckout({ tenant: 'nouf', plan }))
        .rejects.toMatchObject({ code: 'UNKNOWN_PLAN', statusCode: 400 });
    }
    await expect(confirmCheckout({ tenant: 'nouf', plan: 'pay_in_4', orderRef: 'other' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_ORDER', statusCode: 400 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it.each(['pay_in_4', 'pay_in_6', 'pay_in_12'])('confirms %s with payments that add up to the order total', async (plan) => {
    const { success, checkout } = await confirmCheckout({ tenant: 'nouf', plan, orderRef: TENANTS.nouf.order.orderRef });
    expect(success).toBe(true);
    expect(checkout.payments).toHaveLength(INSTALMENT_PLANS[plan].instalments);
    const sum = checkout.payments.reduce((total, p) => total + Math.round(p.amount * 100), 0);
    expect(sum).toBe(Math.round(TENANTS.nouf.order.amount * 100));
    expect(checkout.payToday).toBe(checkout.payments[0].amount);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('schedules Pay in 4 as a quarter today and monthly after', () => {
    const plan = buildPaymentPlan(TENANTS.nouf.order, 'pay_in_4', new Date('2026-10-08T10:00:00Z'));
    expect(plan.payments.map((p) => p.dueDate)).toEqual(['2026-10-08', '2026-11-08', '2026-12-08', '2027-01-08']);
    expect(plan.payments.map((p) => p.amount)).toEqual([1374.75, 1374.75, 1374.75, 1374.75]);
  });

  it('clamps month-end due dates to the last day of shorter months', () => {
    const plan = buildPaymentPlan(TENANTS.nouf.order, 'pay_in_4', new Date('2026-01-31T10:00:00Z'));
    expect(plan.payments.map((p) => p.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('fails Pay in 24 with a TypeError and alerts under the tenant label and schedule key', async () => {
    await expect(confirmCheckout({ tenant: 'nouf', plan: 'pay_in_24', orderRef: 'TMR-ORD-7731-20582' }))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('c45a2e16');
    expect(alert.verticalLabel).toBe(TENANTS.nouf.label);
    expect(alert.service).toBe('checkout-plans-api');
    expect(alert.tags).toContainEqual({ key: 'plan_schedule', value: 'pay_in_24_nouf' });
    expect(alert.tags).toContainEqual({ key: 'route', value: '/api/c45a2e16/nouf/checkout' });
  });
});

describe('checkout plan page', () => {
  const { renderPage } = require('../app/routes/verticals/c45a2e16');

  it('writes each tenant\'s own order into its page', () => {
    const sara = {
      order: { orderRef: 'TMR-ORD-1111-00001', merchant: 'Jeddah <Gadgets>', item: 'AirPods Pro, White', amount: 999, currency: 'SAR' },
    };
    const noufPage = renderPage(TENANTS.nouf);
    const saraPage = renderPage(sara);
    expect(noufPage).toContain(`"orderRef":"${TENANTS.nouf.order.orderRef}"`);
    expect(saraPage).toContain('"orderRef":"TMR-ORD-1111-00001"');
    expect(saraPage).toContain('"amount":999');
    expect(saraPage).not.toContain(TENANTS.nouf.order.orderRef);
    expect(saraPage).not.toContain('Jeddah <Gadgets>');
    expect(saraPage).not.toContain('__TENANT_ORDER__');
  });
});

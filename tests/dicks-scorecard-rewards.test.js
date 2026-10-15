jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { placeOrder, MEMBERS, REWARD_CERTIFICATES } = require('../app/services/verticals/1b17e823');

const order = (memberId) => placeOrder({
  items: [{ sku: '24NIKMPGSS41RDXXXRNN', qty: 1 }, { sku: '20SPAUTF1000LGCYBSKB', qty: 1 }],
  memberId,
  fulfillment: 'ship',
  storeNumber: '0212',
  zipCode: '15205',
  paymentMethod: 'card',
});

describe("DICK'S checkout ScoreCard reward redemption (1b17e823)", () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('a member with a migrated reward code fails checkout and fires the automation alert', async () => {
    await expect(order('SC-8841207733')).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('1b17e823');
    expect(alert.culprit).toContain('applyScoreCardRewards');
    expect(alert.errorValue).toContain("reading 'value'");
  });

  test('a member with no rewards checks out normally without an alert', async () => {
    const result = await order('SC-5520917046');
    expect(result.success).toBe(true);
    expect(result.rewards).toEqual({ codes: [], discount: 0 });
    expect(result.scorecard.tierLabel).toBe('ScoreCard Gold');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('guest checkout succeeds without an alert', async () => {
    const result = await order('guest');
    expect(result.success).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a reward code in the ledger format is applied to the order total', async () => {
    const jordan = MEMBERS['SC-8841207733'];
    const original = jordan.availableRewards;
    jordan.availableRewards = Object.keys(REWARD_CERTIFICATES).slice(0, 1);
    try {
      const result = await order('SC-8841207733');
      expect(result.rewards.discount).toBe(10);
      expect(result.total).toBe(result.subtotal + result.shipping.fee + result.tax.tax - 10);
    } finally {
      jordan.availableRewards = original;
    }
  });

  test('no member data references the retired linked-program crosswalk', () => {
    Object.values(MEMBERS).forEach((m) => expect(m).not.toHaveProperty('linkedProgram'));
  });
});

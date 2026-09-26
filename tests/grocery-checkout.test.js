/* global describe, expect, jest, test */

jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { checkoutOrder, CART_ITEMS } = require('../app/services/oncall-verticals/grocery');
const { ALERT_SCENARIOS } = require('../app/services/oncall');

jest.setTimeout(30000);

describe('grocery checkout order total', () => {
  test('fails fast while calculating the order total', async () => {
    const started = Date.now();
    let caught;
    try {
      await checkoutOrder({
        storeId: '1039',
        lines: CART_ITEMS.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        pickupSlot: '2026-09-27T08:00',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.code).toBe('ORDER_TOTAL_FAILED');
    expect(Date.now() - started).toBeLessThan(300);
  });

  test('rejects an unknown sku', async () => {
    await expect(checkoutOrder({
      storeId: '1039',
      lines: [{ sku: '00000000_XX', quantity: 1 }],
    })).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });

  test('alert scenario is unlisted and describes the symptom, not the cause', () => {
    const scenario = ALERT_SCENARIOS.grocery;
    expect(scenario.unlisted).toBe(true);
    expect(scenario.endpoint).toBe('POST /api/oncall/grocery/checkout');
    expect(`${scenario.symptom} ${scenario.impact}`).not.toMatch(/\.js|reward|minQty|TypeError/);
  });
});

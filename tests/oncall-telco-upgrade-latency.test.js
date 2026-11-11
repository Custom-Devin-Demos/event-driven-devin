/* global describe, expect, test */
const { upgradePlan, PLAN_CATALOG } = require('../app/services/oncall-verticals/telco');

describe('telco plan upgrade latency', () => {
  test('latency does not scale with the plan catalog size', async () => {
    expect(PLAN_CATALOG.length).toBeGreaterThan(30);
    const started = Date.now();
    const result = await upgradePlan({
      accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'FAMILY-PLUS-12', billingDay: 15,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ success: true, status: 'upgraded', newPlan: 'Family Plus' });
  });

  test('a legacy or regional target plan is still rejected as ineligible', async () => {
    await expect(upgradePlan({
      accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'LEGACY-01', billingDay: 15,
    })).rejects.toMatchObject({ code: 'INELIGIBLE_PLAN' });
  });

  test('an unknown plan code is rejected', async () => {
    await expect(upgradePlan({
      accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'NOPE-99', billingDay: 15,
    })).rejects.toMatchObject({ code: 'UNKNOWN_PLAN' });
  });
});

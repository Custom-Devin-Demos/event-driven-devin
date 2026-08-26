const { applyRewards, REWARDS_PROGRAMS } = require('../app/services/verticals/tacobell');

const pricing = {
  subtotal: '10.00',
  tax: '0.73',
  taxLabel: 'CA state + local',
  serviceFee: '0.50',
  total: '11.23',
  itemCount: 1,
};

describe('Taco Bell rewards tiers', () => {
  it('every tier offered by the UI has a registered rewards program', () => {
    expect(REWARDS_PROGRAMS.hot_tier).toBeDefined();
    expect(REWARDS_PROGRAMS.fire_tier).toBeDefined();
  });

  it('applies the Fire tier without throwing (regression: NODE-EXPRESS-57)', () => {
    const result = applyRewards(pricing, 'fire');
    expect(result.rewardsTier).toBe('fire');
    expect(result.rewardsPoints).toBe(20);
  });

  it('applies the Hot tier', () => {
    const result = applyRewards(pricing, 'hot');
    expect(result.rewardsTier).toBe('hot');
    expect(result.rewardsPoints).toBe(10);
  });

  it('falls back to the base tier for an unknown tier', () => {
    const result = applyRewards(pricing, 'diablo');
    expect(result.rewardsTier).toBe('hot');
    expect(result.rewardsPoints).toBe(10);
  });

  it('falls back to the base tier when no tier is supplied', () => {
    expect(applyRewards(pricing, undefined).rewardsPoints).toBe(10);
    expect(applyRewards(pricing, null).rewardsTier).toBe('hot');
  });

  it('preserves the pricing fields it is given', () => {
    const result = applyRewards(pricing, 'fire');
    expect(result).toMatchObject(pricing);
  });
});

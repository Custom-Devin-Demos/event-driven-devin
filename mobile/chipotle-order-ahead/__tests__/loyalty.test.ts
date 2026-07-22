import { earnedPoints } from '../src/lib/loyalty';

describe('loyalty', () => {
  it('earns 10 points per dollar of order total', () => {
    expect(earnedPoints(17.96)).toBe(179);
  });

  it('earns no points for a zero total', () => {
    expect(earnedPoints(0)).toBe(0);
  });
});

import {
  applyPromo,
  calcTax,
  calcTotals,
  PROMOS,
} from '../src/lib/pricing';

describe('pricing', () => {
  it('returns the subtotal unchanged when no promo is applied', () => {
    expect(applyPromo(20)).toBe(20);
  });

  it('applies a percent promo', () => {
    // GUAC20 = 20% off
    expect(applyPromo(20, PROMOS.GUAC20)).toBe(16);
  });

  it('computes state sales tax', () => {
    expect(calcTax(16, 'CA')).toBeCloseTo(1.16, 2);
  });

  it('returns zero tax for an unknown state', () => {
    expect(calcTax(16, 'ZZ')).toBe(0);
  });

  it('computes full totals with a percent promo', () => {
    const totals = calcTotals(20, 'CA', PROMOS.GUAC20);
    expect(totals.discount).toBe(4);
    expect(totals.tax).toBeCloseTo(1.16, 2);
    expect(totals.serviceFee).toBeCloseTo(0.8, 2);
    expect(totals.total).toBeCloseTo(17.96, 2);
  });
});

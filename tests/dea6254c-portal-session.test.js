/* global describe, expect, test, jest */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const {
  openPortalSession,
  valueHolding,
  resolveValuationPoint,
  buildStatementPeriod,
  FUNDS,
  INVESTORS,
  REPORTING_CALENDAR,
} = require('../app/services/verticals/dea6254c');

describe('resolveValuationPoint', () => {
  test('returns the exact strike when the fund publishes on the statement date', () => {
    const point = resolveValuationPoint(FUNDS.WEL, REPORTING_CALENDAR.currentPeriodEnd);
    expect(point).toEqual({ asOf: '2026-08-31', navPerUnit: 4276.91 });
  });

  test('carries a quarterly fund at its latest strike on or before the statement date', () => {
    const point = resolveValuationPoint(FUNDS.TAC, REPORTING_CALENDAR.currentPeriodEnd);
    expect(point).toEqual({ asOf: '2026-06-30', navPerUnit: 1698.35 });
  });

  test('returns undefined when no strike exists on or before the date', () => {
    expect(resolveValuationPoint(FUNDS.TAC, '2025-01-31')).toBeUndefined();
  });
});

describe('valueHolding', () => {
  const period = buildStatementPeriod();

  test('values a quarterly-fund holding (the original TypeError case)', () => {
    const tacHolding = INVESTORS['INV-208431'].holdings.find((h) => h.fundCode === 'TAC');
    const position = valueHolding(tacHolding, period);

    expect(position.navPerUnit).toBe(1698.35);
    expect(position.valuationDate).toBe('2026-06-30');
    expect(position.marketValue).toBe(Math.round(4150 * 1698.35 * 100) / 100);
    expect(position.periodReturnPct).toBe(0);
  });

  test('computes period return for a monthly fund from the prior strike', () => {
    const position = valueHolding(
      { fundCode: 'WEL', shareClass: 'A', units: 10, costBasisPerUnit: 4000 },
      period,
    );
    expect(position.valuationDate).toBe('2026-08-31');
    expect(position.periodReturnPct).toBeCloseTo(1.07, 2);
  });

  test('rejects with a ValidationError when the fund has no strike yet', () => {
    expect(() => valueHolding(
      { fundCode: 'TAC', shareClass: 'I', units: 1, costBasisPerUnit: 1 },
      { asOf: '2025-01-31', priorAsOf: '2024-12-31', label: 'test' },
    )).toThrow(expect.objectContaining({ name: 'ValidationError', code: 'NAV_NOT_AVAILABLE' }));
  });
});

describe('openPortalSession', () => {
  test('opens a session for the default investor holding a quarterly fund', async () => {
    const result = await openPortalSession({ investorId: 'INV-208431' });

    expect(result.success).toBe(true);
    expect(result.portfolio.positions).toHaveLength(3);
    const tac = result.portfolio.positions.find((p) => p.fundCode === 'TAC');
    expect(tac.valuationDate).toBe('2026-06-30');
    expect(result.portfolio.totalMarketValue).toBeGreaterThan(0);
  });

  test('opens a session for an investor with only monthly funds', async () => {
    const result = await openPortalSession({ investorId: 'INV-114926' });
    expect(result.success).toBe(true);
    expect(result.portfolio.positions.every((p) => p.valuationDate === '2026-08-31')).toBe(true);
  });
});

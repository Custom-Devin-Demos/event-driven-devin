jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
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
const { createSessionAndAlert } = require('../app/services/devin-session');

describe('resolveValuationPoint', () => {
  test('returns the exact strike when the fund struck NAV on the statement date', () => {
    const point = resolveValuationPoint(FUNDS.WEL, REPORTING_CALENDAR.currentPeriodEnd);
    expect(point).toEqual({ asOf: '2026-08-31', navPerUnit: 4276.91 });
  });

  test('falls back to the most recent strike on or before the statement date for quarterly funds', () => {
    const point = resolveValuationPoint(FUNDS.TAC, REPORTING_CALENDAR.currentPeriodEnd);
    expect(point).toEqual({ asOf: '2026-06-30', navPerUnit: 1698.35 });
  });

  test('returns null when no strike exists on or before the requested date', () => {
    expect(resolveValuationPoint(FUNDS.TAC, '2025-01-31')).toBeNull();
  });

  test('tolerates a fund with no NAV history or malformed points', () => {
    expect(resolveValuationPoint({ code: 'X' }, '2026-08-31')).toBeNull();
    expect(resolveValuationPoint({ code: 'X', navHistory: [null, { asOf: '2026-06-30' }] }, '2026-08-31')).toBeNull();
  });
});

describe('valueHolding', () => {
  const period = buildStatementPeriod();

  test('values a quarterly-struck holding (TAC) without throwing — the NODE-EXPRESS-73 regression', () => {
    const holding = INVESTORS['INV-208431'].holdings.find((h) => h.fundCode === 'TAC');
    const position = valueHolding(holding, period);
    expect(position.navPerUnit).toBe(1698.35);
    expect(position.valuationDate).toBe('2026-06-30');
    expect(position.marketValue).toBe(7048152.5);
    expect(position.periodReturnPct).toBeNull();
  });

  test('computes period return for a monthly-struck holding', () => {
    const holding = INVESTORS['INV-208431'].holdings.find((h) => h.fundCode === 'WEL');
    const position = valueHolding(holding, period);
    expect(position.valuationDate).toBe('2026-08-31');
    expect(position.periodReturnPct).toBeCloseTo(1.0736, 4);
  });

  test('rejects with a ValidationError when a fund has no usable NAV strike', () => {
    const holding = INVESTORS['INV-208431'].holdings.find((h) => h.fundCode === 'TAC');
    expect(() => valueHolding(holding, { asOf: '2025-01-31', priorAsOf: '2024-12-31' }))
      .toThrow(expect.objectContaining({ name: 'ValidationError', code: 'NAV_NOT_AVAILABLE' }));
  });
});

describe('openPortalSession', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('opens a session for INV-208431, whose holdings include a quarterly fund', async () => {
    const result = await openPortalSession({ investorId: 'INV-208431' });
    expect(result.success).toBe(true);
    expect(result.portfolio.positions).toHaveLength(3);
    expect(result.portfolio.positions.map((p) => p.fundCode)).toEqual(['WEL', 'KEN', 'TAC']);
    expect(result.portfolio.totalMarketValue).toBeGreaterThan(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('opens a session for INV-114926', async () => {
    const result = await openPortalSession({ investorId: 'INV-114926' });
    expect(result.success).toBe(true);
    expect(result.portfolio.positions).toHaveLength(2);
  });

  test('rejects unknown investors with a ValidationError', async () => {
    await expect(openPortalSession({ investorId: 'INV-000000' }))
      .rejects.toMatchObject({ name: 'ValidationError', code: 'INVESTOR_NOT_FOUND' });
  });
});

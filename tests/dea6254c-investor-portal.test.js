jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

/* global describe, expect, test, afterEach, jest */

const {
  openPortalSession,
  FUNDS,
} = require('../app/services/verticals/dea6254c');

describe('investor portal session (dea6254c)', () => {
  const originalTacNavHistory = [...FUNDS.TAC.navHistory];

  afterEach(() => {
    FUNDS.TAC.navHistory = [...originalTacNavHistory];
  });

  test('values the quarterly TAC position using its latest available strike', async () => {
    const result = await openPortalSession({ investorId: 'INV-208431' });
    const tacPosition = result.portfolio.positions.find((position) => position.fundCode === 'TAC');

    expect(result.success).toBe(true);
    expect(result.portfolio.positions).toHaveLength(3);
    expect(tacPosition).toMatchObject({
      valuationDate: '2026-06-30',
      navPerUnit: 1698.35,
      marketValue: 7048152.5,
      periodReturnPct: null,
    });
  });

  test('uses monthly NAV strikes for the endowment investor', async () => {
    const result = await openPortalSession({ investorId: 'INV-114926' });
    const welPosition = result.portfolio.positions.find((position) => position.fundCode === 'WEL');

    expect(result.success).toBe(true);
    expect(result.portfolio.positions).toHaveLength(2);
    expect(welPosition.valuationDate).toBe('2026-08-31');
    expect(welPosition.periodReturnPct).toBeCloseTo(1.07, 2);
  });

  test('rejects a holding when no NAV strike is available by the statement date', async () => {
    FUNDS.TAC.navHistory = [{ asOf: '2026-12-31', navPerUnit: 1800 }];

    await expect(openPortalSession({ investorId: 'INV-208431' })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'NAV_NOT_AVAILABLE',
    });
  });

  test('uses the default investor when no investor ID is supplied', async () => {
    const result = await openPortalSession({});

    expect(result.success).toBe(true);
    expect(result.portfolio.investorId).toBe('INV-208431');
  });
});

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { bookOrderLine } = require('../app/services/verticals/2cd6eb18');

const DEFAULT_LINE = { orderNumber: 'AO-000010', slotName: 'INV-00011', units: 4, discountPct: 0 };

describe('FOX Ad Sales order line booking', () => {
  beforeEach(() => jest.clearAllMocks());

  test('default FS1 NASCAR slot rejects with the planted TypeError and triggers a Devin session', async () => {
    await expect(bookOrderLine(DEFAULT_LINE)).rejects.toThrow(/reading 'unitRate'/);

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.anything());
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '2cd6eb18',
      service: 'fox-adsales-booking',
    }));
  });

  test('FOX NFL slot books with the sports premium applied', async () => {
    const result = await bookOrderLine({ ...DEFAULT_LINE, slotName: 'INV-00006', units: 2 });

    expect(result.success).toBe(true);
    expect(result.line).toMatchObject({ rateCard: 'RC-0001', unitRate: 106250, gross: 212500, isSportsPremium: true });
    expect(result.order).toMatchObject({ lineCount: 3, totalGross: 733750, requiresApproval: true });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('FOX Prime slot picks the most recent active rate card', async () => {
    const result = await bookOrderLine({ ...DEFAULT_LINE, slotName: 'INV-00007', units: 1, discountPct: 10 });

    expect(result.line).toMatchObject({ rateCard: 'RC-0007', unitRate: 45000, gross: 40500, isSportsPremium: false });
  });
});

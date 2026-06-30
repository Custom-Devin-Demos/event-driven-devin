jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../devin-session');
const {
  processCardRequest,
  buildSavingsSummary,
  findCard,
  CARDS,
} = require('./054f8313');

describe('buildSavingsSummary', () => {
  // Regression: NODE-EXPRESS-2K — clasica has no `promo`, which previously
  // threw "Cannot read properties of undefined (reading 'monthsWaived')".
  it('handles a card without a promo (clasica) without throwing', () => {
    const card = CARDS.clasica;
    expect(card.promo).toBeUndefined();

    const summary = buildSavingsSummary(card, { monthly: 0 }, []);

    expect(summary.waivedMonths).toBe(0);
    expect(summary.promoSavings).toBe(0);
    expect(summary.promoLabel).toBeNull();
    expect(summary.totalSavings).toBe(0);
  });

  it('applies the promo waiver for a card that has one (oro)', () => {
    const card = CARDS.oro; // annualFee 1200, promo 12 months waived
    const summary = buildSavingsSummary(card, { monthly: 0 }, []);

    expect(summary.waivedMonths).toBe(12);
    expect(summary.promoLabel).toBe('12 meses sin anualidad');
    expect(summary.promoSavings).toBe(1200); // (1200 / 12) * 12
    expect(summary.totalSavings).toBe(1200);
  });

  it('adds bundle savings from selected benefits', () => {
    const card = CARDS.clasica;
    const benefits = [{ saves: 30 }, { saves: 15 }];
    const summary = buildSavingsSummary(card, { monthly: 0 }, benefits);

    expect(summary.bundleSavings).toBe(45);
    expect(summary.totalSavings).toBe(45);
  });

  it('defaults an unknown card to clasica via findCard', () => {
    expect(findCard('does-not-exist')).toBe(CARDS.clasica);
    expect(findCard('oro')).toBe(CARDS.oro);
  });
});

describe('processCardRequest (integration)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
  });

  it('returns a valid offer for a clasica application without firing an alert', async () => {
    const offer = await processCardRequest({ card: 'clasica', term: 12, benefits: [] });

    expect(offer.card).toBe('CLASICA');
    expect(offer.totalSavings).toBe(0);
    expect(offer.requestId).toBeDefined();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('returns a valid offer for a promo card (oro)', async () => {
    const offer = await processCardRequest({ card: 'oro', term: 12, benefits: [] });

    expect(offer.card).toBe('ORO');
    expect(offer.totalSavings).toBeGreaterThan(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

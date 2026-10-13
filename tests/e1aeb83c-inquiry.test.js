jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  processOfferInquiry, resolveOffer, buildQuote, resolvePromotion, getEligibility, applyIntroTerms, summarizeInquiry,
  OFFERS, OWNER,
} = require('../app/services/verticals/e1aeb83c');

describe('Subscription offer inquiry (e1aeb83c) — offers and quotes', () => {
  test('catalog carries the captured annual prices', () => {
    expect(OFFERS['wsj-plus-premier'].pricing.annual).toMatchObject({ intro: 119, renewal: 54.99 });
    expect(OFFERS['wsj-digital'].pricing.annual).toMatchObject({ intro: 79, renewal: 44.99 });
  });

  test('buildQuote prices the selected cadence', () => {
    const quote = buildQuote(resolveOffer('wsj-digital'), 'annual');
    expect(quote).toMatchObject({ offerId: 'wsj-digital', billing: 'annual', introPrice: 79, renewalCycleWeeks: 4 });
  });

  test('resolvePromotion falls back to the default acquisition campaign', () => {
    expect(resolvePromotion(undefined, 'subscribe').code).toBe('6441GOZMW28');
    expect(resolvePromotion('6441gozmw28', 'subscribe').code).toBe('6441GOZMW28');
    expect(resolvePromotion(undefined, 'student-rates').code).toBe('STUDENT');
  });

  test('summarizeInquiry renders the page copy', () => {
    const summary = summarizeInquiry({
      offerId: 'wsj-digital', offerName: 'WSJ Digital', billing: 'annual', introPrice: 79, introTerm: 'year',
      renewalPrice: 44.99, renewalCycleWeeks: 4, promotionCode: 'X', introCycles: 13, requiresVerification: false, titles: ['wsj'],
    }, 'subscribe');
    expect(summary.headline).toBe('$79 for 1 year');
    expect(summary.renewal).toBe('Then $44.99 every 4 weeks thereafter');
  });

  test('unknown offers are rejected with a typed error', () => {
    expect(() => resolveOffer('nope')).toThrow('Unknown offer: nope');
  });
});

describe('Subscription offer inquiry (e1aeb83c) — promotion eligibility', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('getEligibility reads region entries from the eligibility Map', () => {
    const promotion = resolvePromotion(undefined, 'subscribe');
    expect(getEligibility(promotion, 'us')).toMatchObject({ maxIntroCycles: 13, requiresVerification: false });
    expect(getEligibility(promotion, 'EU')).toMatchObject({ maxIntroCycles: 6, requiresVerification: true });
  });

  test('missing or unknown regions fall back to the default market', () => {
    const promotion = resolvePromotion(undefined, 'subscribe');
    expect(getEligibility(promotion, undefined)).toMatchObject({ maxIntroCycles: 13 });
    expect(getEligibility(promotion, null)).toMatchObject({ maxIntroCycles: 13 });
    expect(getEligibility(promotion, 'jp')).toMatchObject({ maxIntroCycles: 13 });
    expect(getEligibility(resolvePromotion(undefined, 'student-rates'), 'eu')).toMatchObject({ maxIntroCycles: 52 });
  });

  test('a promotion with no default-market entry raises a typed error instead of a TypeError', () => {
    const promotion = { code: 'EU_ONLY', eligibility: new Map([['eu', { maxIntroCycles: 6 }]]) };
    expect(() => getEligibility(promotion, 'ca')).toThrow(expect.objectContaining({
      name: 'OfferInquiryError', code: 'PROMOTION_NOT_ELIGIBLE',
    }));
  });

  test('applyIntroTerms caps intro cycles at 52', () => {
    const quote = buildQuote(resolveOffer('wsj-digital'), 'annual');
    const priced = applyIntroTerms(quote, { code: 'X', campaign: 'C' }, { maxIntroCycles: 104, requiresVerification: false, cancelAnytime: true });
    expect(priced.introCycles).toBe(52);
  });

  test('the alerted wsj-digital annual subscribe inquiry now succeeds without alerting', async () => {
    const result = await processOfferInquiry({ offer: 'wsj-digital', billing: 'annual', action: 'subscribe' });
    expect(result).toMatchObject({
      success: true,
      offer: 'wsj-digital',
      billing: 'annual',
      headline: '$79 for 1 year',
      promotion: '6441GOZMW28',
      introCycles: 13,
      requiresVerification: false,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['wsj-plus-premier', 'annual', 'subscribe', undefined],
    ['wsj-digital', 'weekly', 'subscribe', 'ca'],
    ['print-and-digital', 'annual', 'subscribe', 'eu'],
    ['wsj-digital', 'annual', 'student-rates', undefined],
  ])('%s / %s / %s / region=%s succeeds', async (offer, billing, action, region) => {
    const result = await processOfferInquiry({ offer, billing, action, region });
    expect(result.success).toBe(true);
    expect(typeof result.introCycles).toBe('number');
  });
});

describe('Subscription offer inquiry (e1aeb83c) — alerting', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('a failed inquiry raises exactly one alert pinned to the server-side owner', async () => {
    await expect(processOfferInquiry({
      offer: 'unknown-offer', billing: 'annual', action: 'subscribe', viewerUserId: 'client-user', viewerOrgId: 'client-org',
    })).rejects.toThrow('Unknown offer: unknown-offer');

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: 'e1aeb83c',
      slackMemberId: OWNER.slackMemberId,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      errorType: 'OfferInquiryError',
    });
    expect(alert.devinUserId).not.toBe('client-user');
    expect(alert.extra.viewerUserId).toBe('client-user');
  });

  test('instant-path tags keep the Sentry webhook from double-alerting', async () => {
    await processOfferInquiry({ offer: 'unknown-offer', billing: 'annual' }).catch(() => {});
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, tags: alert.tags })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, culprit: alert.culprit, tags: [] })).toBe(true);
  });

  test('reportErrors=false suppresses alerting for reproduction runs', async () => {
    await processOfferInquiry({ offer: 'unknown-offer', billing: 'annual', reportErrors: false }).catch(() => {});
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

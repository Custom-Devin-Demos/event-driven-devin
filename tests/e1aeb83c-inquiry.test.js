jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
const mockCustomerScope = { setClient: jest.fn(), captureException: jest.fn() };
const mockCustomerClient = { init: jest.fn() };
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    NodeClient: jest.fn(() => mockCustomerClient),
    Scope: jest.fn(() => mockCustomerScope),
    makeNodeTransport: jest.fn(),
    defaultStackParser: jest.fn(),
  },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  processOfferInquiry, resolveOffer, buildQuote, resolvePromotion, getEligibility, applyIntroTerms, summarizeInquiry,
  OFFERS, PROMOTIONS, OWNER,
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

describe('Subscription offer inquiry (e1aeb83c) — promotion eligibility (E1AEB83C-SUBSCRIBE-1)', () => {
  const promo = PROMOTIONS['6441GOZMW28'];

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the alerted request (wsj-digital, annual, subscribe) now returns a quote', async () => {
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
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each(Object.keys(OFFERS))('every offer quotes for both cadences (%s)', async (offer) => {
    await expect(processOfferInquiry({ offer, billing: 'annual' })).resolves.toMatchObject({ success: true });
    await expect(processOfferInquiry({ offer, billing: 'weekly' })).resolves.toMatchObject({ success: true });
  });

  test('getEligibility reads the Map-backed table by region', () => {
    expect(getEligibility(promo, 'us')).toMatchObject({ maxIntroCycles: 13 });
    expect(getEligibility(promo, 'EU')).toMatchObject({ maxIntroCycles: 6, requiresVerification: true });
  });

  test('missing or unknown regions fall back to the default market', () => {
    expect(getEligibility(promo, undefined)).toBe(promo.eligibility.get('us'));
    expect(getEligibility(promo, null)).toBe(promo.eligibility.get('us'));
    expect(getEligibility(promo, 'jp')).toBe(promo.eligibility.get('us'));
  });

  test('student promotion resolves its verified eligibility', async () => {
    const result = await processOfferInquiry({ offer: 'wsj-digital', billing: 'annual', action: 'student-rates' });
    expect(result).toMatchObject({ promotion: 'STUDENT', introCycles: 52, requiresVerification: true });
  });

  test('a promotion with no eligibility for the market or default raises a typed error, not a TypeError', () => {
    const regional = { code: 'EU_ONLY', eligibility: new Map([['eu', { maxIntroCycles: 6 }]]) };
    expect(() => getEligibility(regional, 'us')).toThrow(expect.objectContaining({
      name: 'OfferInquiryError', code: 'PROMOTION_INELIGIBLE',
    }));
  });

  test('applyIntroTerms caps intro cycles at 52', () => {
    const quote = buildQuote(resolveOffer('wsj-digital'), 'weekly');
    const priced = applyIntroTerms(quote, promo, { maxIntroCycles: 104, requiresVerification: false, cancelAnytime: true });
    expect(priced.introCycles).toBe(52);
  });
});

describe('Subscription offer inquiry (e1aeb83c) — alerting', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('a failed inquiry raises exactly one alert pinned to the server-side owner', async () => {
    await expect(processOfferInquiry({
      offer: 'retired-offer', billing: 'annual', action: 'subscribe', viewerUserId: 'client-user', viewerOrgId: 'client-org',
    })).rejects.toThrow('Unknown offer: retired-offer');

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
    await processOfferInquiry({ offer: 'retired-offer', billing: 'annual' }).catch(() => {});
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, tags: alert.tags })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, culprit: alert.culprit, tags: [] })).toBe(true);
  });

  test('reportErrors=false suppresses alerting for reproduction runs', async () => {
    await expect(processOfferInquiry({ offer: 'retired-offer', billing: 'annual', reportErrors: false }))
      .rejects.toThrow('Unknown offer');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('per-customer Sentry routing', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  test('uses SENTRY_DSN_E1AEB83C when set and leaves the global client alone', async () => {
    process.env.SENTRY_DSN_E1AEB83C = 'https://abc@o1.ingest.sentry.io/2';
    process.env.SENTRY_ORG_SLUG_E1AEB83C = 'customer-org';
    process.env.SENTRY_PROJECT_ID_E1AEB83C = '2';
    Sentry.captureException.mockClear();
    createSessionAndAlert.mockClear();
    let run;
    jest.isolateModules(() => { ({ processOfferInquiry: run } = require('../app/services/verticals/e1aeb83c')); });

    await expect(run({ offer: 'retired-offer', billing: 'annual' })).rejects.toThrow('Unknown offer');

    expect(Sentry.NodeClient).toHaveBeenCalledWith(expect.objectContaining({ dsn: process.env.SENTRY_DSN_E1AEB83C, integrations: [] }));
    expect(mockCustomerClient.init).toHaveBeenCalledTimes(1);
    expect(mockCustomerScope.setClient).toHaveBeenCalledWith(mockCustomerClient);
    expect(mockCustomerScope.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].issueUrl).toBe('https://customer-org.sentry.io/issues/?project=2&query=is%3Aunresolved');
  });

  test('falls back to the global Sentry client when no customer DSN is set', async () => {
    delete process.env.SENTRY_DSN_E1AEB83C;
    Sentry.captureException.mockClear();
    mockCustomerScope.captureException.mockClear();
    let run;
    jest.isolateModules(() => { ({ processOfferInquiry: run } = require('../app/services/verticals/e1aeb83c')); });
    await expect(run({ offer: 'retired-offer', billing: 'annual' })).rejects.toThrow('Unknown offer');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockCustomerScope.captureException).not.toHaveBeenCalled();
  });
});

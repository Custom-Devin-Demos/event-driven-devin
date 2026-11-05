jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => {
  const actual = jest.requireActual('../app/services/devin-session');
  return { ...actual, createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })) };
});

const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { buildAlertBlocks } = require('../app/services/slack');
const svc = require('../app/services/verticals/7019ea46');
const customer = require('../config/customers/7019ea46');

describe('Whiskas Dry Cat Food — Buy Now (7019ea46)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('catalog mirrors the nine dry recipes on whiskas.co.uk', () => {
    expect(svc.CATALOG).toHaveLength(9);
    expect(svc.CATALOG.map((p) => p.lifeStage).sort()).toEqual(['adult', 'adult', 'adult', 'adult', 'adult', 'adult', 'kitten', 'kitten', 'senior']);
    expect(svc.RETAILERS.map((r) => r.name)).toContain('Tesco');
    svc.CATALOG.forEach((p) => expect(p.image).toMatch(/^https:\/\/www\.whiskas\.co\.uk\/cdn-cgi\/image\//));
    svc.CATALOG.forEach((p) => expect(p.url).toMatch(/^https:\/\/www\.whiskas\.co\.uk\/cat-food\/dry-cat-food\//));
  });

  test('kitten recipe returns seven priced retailer offers, cheapest first, with the Kitten Club promo', async () => {
    const res = await svc.getRetailerOffers({ ean: '5900951355875' });
    expect(res.success).toBe(true);
    expect(res.offers).toHaveLength(7);
    expect(res.cheapest.retailer).toBe('Amazon');
    expect(res.offers.every((o, i, arr) => i === 0 || arr[i - 1].price <= o.price)).toBe(true);
    expect(res.offers[0].promo).toBe('Kitten Club 10% off');
    expect(res.offers[0].wasPrice).toBeGreaterThan(res.offers[0].price);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('adult recipe prices at RRP with no promo', async () => {
    const res = await svc.getRetailerOffers({ ean: '5998749128589' });
    const tesco = res.offers.find((o) => o.retailer === 'Tesco');
    expect(tesco.price).toBeCloseTo(4.2 * 1.9, 2);
    expect(tesco.promo).toBeNull();
    expect(tesco.url).toBe(`https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent('Whiskas 1+ Adult with Chicken Dry Cat Food 1.9kg')}`);
  });

  test('missing or unknown EAN is a 400 ValidationError and does not alert', async () => {
    await expect(svc.getRetailerOffers({})).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'EAN_REQUIRED' });
    await expect(svc.getRetailerOffers({ ean: '0000000000000' })).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'UNKNOWN_PRODUCT' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Senior 7+ with Chicken throws the planted TypeError and raises an instant New Relic-tagged alert', async () => {
    let caught;
    try {
      await svc.getRetailerOffers({ ean: '5998749128626', devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'marcel@devindemos.com' });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toBe("Cannot read properties of undefined (reading 'rrpPerKg')");
    expect(caught.status).toBe(500);
    expect(caught.code).toBe('RETAILER_PRICING_FAILED');
    expect(caught.newRelic).toMatchObject({ source: 'New Relic', incidentId: '88412067' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, sentryCtx] = Sentry.captureException.mock.calls[0];
    expect(sentryCtx.tags).toMatchObject({ alert_path: 'instant', customer: '7019ea46', apm_monitor: 'new-relic', life_stage: 'senior' });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: '7019ea46',
      errorType: 'TypeError',
      culprit: svc.CULPRIT,
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'marcel@devindemos.com',
    });
    expect(alert.newRelic).toMatchObject({
      source: 'New Relic',
      appName: 'whiskas-uk-web (production)',
      errorRate: '31.4%',
    });
    expect(alert.newRelic.incidentUrl).toContain('one.newrelic.com');
    expect(alert.promptAppendix).toContain('New Relic');
    expect(alert.promptAppendix).toContain('Senior 7+');
  });

  test('Teams card names New Relic in the fields, the top-level footer and an action button', () => {
    const { buildTeamsAlertCardForAlert } = jest.requireActual('../app/services/devin-session');
    const nr = svc.buildNewRelicSignal('WK-TEST-1234');
    const card = buildTeamsAlertCardForAlert({
      issueTitle: 'TypeError: boom', errorType: 'TypeError', errorValue: 'boom', service: svc.SERVICE,
      verticalLabel: 'Whiskas Dry Cat Food — Buy Now', customer: '7019ea46', newRelic: nr, issueUrl: 'https://sentry.io/x',
    });
    const all = JSON.stringify(card);
    expect(all).toContain('New Relic');
    expect(all).toContain('View incident in New Relic');
    expect(all).toContain(nr.incidentUrl);
    const footer = JSON.stringify(card.body.filter((b) => b.type === 'TextBlock'));
    expect(footer).toContain('New Relic: incident 88412067');
    expect(footer).toContain(nr.traceId);
    expect(footer).toContain('31.4%');
  });

  test('Slack card renders the New Relic section and incident button', () => {
    const nr = svc.buildNewRelicSignal('WK-TEST-1234');
    const blocks = buildAlertBlocks({
      issueTitle: 'TypeError: boom', errorType: 'TypeError', errorValue: 'boom', service: svc.SERVICE,
      verticalLabel: 'Whiskas Dry Cat Food — Buy Now', customer: '7019ea46', newRelic: nr, issueUrl: 'https://sentry.io/x',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('APM signal — New Relic');
    expect(text).toContain('3,972');
    const buttons = blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text);
    expect(buttons.some((b) => b.includes('New Relic'))).toBe(true);
  });

  test('Devin prompt carries the New Relic incident and trace', () => {
    const { buildPrompt } = jest.requireActual('../app/services/devin-session');
    const nr = svc.buildNewRelicSignal('WK-TEST-1234');
    const prompt = buildPrompt({ issueTitle: 'TypeError: boom', errorType: 'TypeError', errorValue: 'boom', service: svc.SERVICE, customer: '7019ea46', newRelic: nr, issueUrl: 'https://sentry.io/x' });
    expect(prompt).toContain('New Relic');
    expect(prompt).toContain(nr.incidentUrl);
  });

  test('customer config is API-triggered and aliased to /whiskas', () => {
    expect(customer.triggerMode).toBe('api');
    expect(customer.aliases).toEqual(['whiskas']);
    expect(customer.label).toContain('Whiskas');
  });
});

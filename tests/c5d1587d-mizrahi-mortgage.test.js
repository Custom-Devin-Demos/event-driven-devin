jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const svc = require('../app/services/verticals/c5d1587d');
const router = require('../app/routes/verticals/c5d1587d');
const { getCustomerConfig, listAliases } = require('../config/customers');

const ASSETS = path.join(__dirname, '../app/public/verticals/c5d1587d-assets');
const NOW = new Date('2026-11-17T08:00:00Z');
const application = (o = {}) => ({
  property: { purpose: 'first-home', price: 2650000, city: 'רמת גן', greenCertified: true, newBuild: true, ...o.property },
  borrower: { fullName: 'נועה לוי', idNumber: '039337423', phone: '052-6184402', netIncome: 32500, obligations: 1200, ...o.borrower },
  loan: { amount: 1850000, years: 30, mix: 'recommended', ...o.loan },
});
beforeEach(() => jest.clearAllMocks());

describe('registration and assets', () => {
  test('registers the slug, aliases and Slack routing without operator identity', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM', slackChannelId: 'C0BNWUGCWBS' });
    for (const alias of ['mizrahi', 'mizrahi-tefahot', 'tefahot']) expect(listAliases()[alias]).toBe('c5d1587d');
    const config = require('../config/customers/c5d1587d');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
  });

  test('page is RTL Hebrew, carries the mock banner, pre-fills the failing path and serves local fonts', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/c5d1587d.html'), 'utf8');
    expect(html).toMatch(/<html dir="rtl" lang="he-IL">/);
    expect(html).toContain('THIS IS A MOCK');
    expect(html).toContain('אישור משכנתא בדיגיטל');
    expect(html).toMatch(/id="green" checked/);
    for (const src of html.match(/<img [^>]*src="https:[^"]+"[^>]*>/g)) expect(src).toContain('onerror=');
    const js = fs.readFileSync(path.join(ASSETS, 'offer.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`'${key}'`);
    expect(js).toContain("'/api/c5d1587d/mortgage-offers'");
    for (const f of ['logo.svg', 'logo-mark.svg', 'OpenSansHebrew-Regular.woff2', 'OpenSansHebrew-Bold.woff2', 'OpenSansHebrew-Light.woff2', 'OpenSansHebrew-ExtraBold.woff2']) {
      expect(fs.statSync(path.join(ASSETS, f)).size).toBeGreaterThan(1000);
    }
  });
});

describe('pricing rules', () => {
  test.each([
    ['non-green recommended mix', application({ property: { greenCertified: false } })],
    ['green uniform mix 1', application({ loan: { mix: 'uniform-1' } })],
    ['green uniform mix 2', application({ loan: { mix: 'uniform-2' } })],
    ['green uniform mix 3', application({ loan: { mix: 'uniform-3' } })],
    ['investment at 50% LTV', application({ property: { purpose: 'investment', greenCertified: false }, loan: { amount: 1300000 } })],
  ])('%s is approved in principle', async (_label, app) => {
    const offer = await svc.requestOffer({ application: app }, NOW);
    expect(offer).toMatchObject({ success: true, status: 'APPROVED_IN_PRINCIPLE', validUntil: '2026-12-11', firstName: 'נועה' });
    expect(offer.offerId).toMatch(/^TF-2026-\d{7}$/);
    expect(offer.tracks.reduce((s, t) => s + t.principal, 0)).toBeGreaterThan(app.loan.amount - 3);
    expect(offer.paymentToIncome).toBeLessThanOrEqual(50);
    expect(svc.getOffer(offer.offerId)).toEqual(offer);
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('green fixed track carries the 0.15pp discount and Spitzer payments are correct', async () => {
    const offer = await svc.requestOffer({ application: application({ loan: { mix: 'uniform-1' } }) }, NOW);
    expect(offer.tracks).toEqual([expect.objectContaining({ code: 'KLTZ_GREEN', annualRate: 4.9, share: 100 })]);
    expect(Math.round(svc.spitzerPayment(1000000, 6, 30))).toBe(5996);
  });

  test('Bank of Israel mix limits are enforced', () => {
    expect(() => svc.checkMixRules([{ code: 'PRIME', share: 1 }])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => svc.checkMixRules([{ code: 'PRIME', share: 0.5 }, { code: 'MSH5_LTZ', share: 0.5 }])).toThrow(/קבועה/);
  });

  test.each([
    null, [], {}, application({ property: { purpose: 'yacht' } }), application({ property: { price: 100 } }),
    application({ borrower: { idNumber: '123456789' } }), application({ borrower: { phone: '03-1234567' } }),
    application({ borrower: { netIncome: 0 } }), application({ loan: { years: 40 } }), application({ loan: { mix: '__proto__' } }),
    application({ loan: { amount: 2100000 } }), application({ property: { purpose: 'investment' } }),
    application({ property: { greenCertified: false }, borrower: { netIncome: 12000 } }),
  ])('rejects invalid or unaffordable applications before alerting: %j', async input => {
    await expect(svc.requestOffer({ application: input }, NOW)).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'INVALID_MORTGAGE_APPLICATION' });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('Israeli ID checksum', () => {
    expect(svc.isValidIsraeliId('039337423')).toBe(true);
    expect(svc.isValidIsraeliId('000000018')).toBe(true);
    expect(svc.isValidIsraeliId('039337424')).toBe(false);
  });
});

describe('green recommended-mix pricing failure', () => {
  test('captures one Sentry event and one instant alert without borrower PII', async () => {
    await expect(svc.requestOffer({ application: application(), devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' }, NOW)).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'baseRate')", status: 500, code: 'MTG-PRC-5003', reference: expect.stringMatching(/^TF-2026-/),
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: 'c5d1587d', service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { mix: 'recommended', greenCertified: true } });
    expect(JSON.stringify(alert)).not.toMatch(/נועה|039337423|6184402|32500/);
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(buildPrompt(alert)).toContain('c5d1587d');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('never merge or deploy');
    expect(alert.promptAppendix).toContain('not draft');
    expect(alert.promptAppendix).toContain('request Devin Review');
  });

  test('suppressed alerts keep the failure but skip alerting', async () => {
    await expect(svc.requestOffer({ application: application(), suppressAlerts: true }, NOW)).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alert delivery failures never replace the original error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.requestOffer({ application: application() }, NOW)).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for mortgage offer failure', expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
  let server; let port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  test('catalog exposes options but not the internal rate sheet', async () => {
    const res = await call('GET', '/api/c5d1587d/catalog');
    expect(res.status).toBe(200); expect(res.body.mixes).toHaveLength(4); expect(res.body.purposes).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/baseRate|spread/);
  });

  test('500 on the green recommended mix, 200 otherwise, 400 on invalid input, 404 on unknown offers', async () => {
    expect(await call('POST', '/api/c5d1587d/mortgage-offers', { application: application(), devinUserId: 'route-user', devinOrgId: 'route-org' }))
      .toMatchObject({ status: 500, body: { success: false, code: 'MTG-PRC-5003', errorClass: 'TypeError', reference: expect.stringMatching(/^TF-/) } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    jest.clearAllMocks();
    expect(await call('POST', '/api/c5d1587d/mortgage-offers', { application: application(), reports: 'off' })).toMatchObject({ status: 500 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    const ok = await call('POST', '/api/c5d1587d/mortgage-offers', { application: application({ property: { greenCertified: false } }) });
    expect(ok).toMatchObject({ status: 200, body: { success: true } });
    expect(await call('GET', `/api/c5d1587d/mortgage-offers/${ok.body.offerId}`)).toMatchObject({ status: 200, body: { offerId: ok.body.offerId } });
    expect(await call('GET', '/api/c5d1587d/mortgage-offers/TF-0000-0000000')).toMatchObject({ status: 404, body: { code: 'OFFER_NOT_FOUND' } });
    expect(await call('POST', '/api/c5d1587d/mortgage-offers', { application: application({ borrower: { idNumber: '1' } }) })).toMatchObject({ status: 400, body: { field: 'idNumber' } });
    expect(await call('POST', '/api/c5d1587d/mortgage-offers')).toMatchObject({ status: 400 });
  });
});

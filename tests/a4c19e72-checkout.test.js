jest.mock('axios');
const axios = require('axios');
const express = require('express');
jest.mock('../app/services/slack', () => ({ postAlertToSlack: jest.fn(), postBugReportToTriage: jest.fn(), postDevinSessionLink: jest.fn() }));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const { Sentry } = require('../app/telemetry/sentry');
const { scheduleVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { postAlertToSlack, postBugReportToTriage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const fs = require('fs');
const path = require('path');
const service = require('../app/services/verticals/a4c19e72');
const { reportCheckoutError, buildAlertData } = require('../app/services/verticals/a4c19e72-alert');
const { runWithAlertDestination, alertDestinationFromCookie } = require('../app/services/alert-destination');
const error = new TypeError("Cannot read properties of undefined (reading 'fee')");
const sentryEventId = '0123456789abcdef0123456789abcdef';
const report = (input = {}) => runWithAlertDestination('teams', () => reportCheckoutError(error, input));
const router = require('../app/routes/verticals/a4c19e72');
const fridge = { sku: 'DEMO-FRIDGE', qty: 1 };
const battery = { sku: 'DEMO-BATTERY', qty: 1 };
const keys = ['NODE_ENV', 'CI', 'LOWES_DEMO_DRY_RUN', 'LOWES_TEAMS_WEBHOOK_URL', 'AUTOMATIONS_TEAMS_WEBHOOK_URL', 'SENTRY_ORG_SLUG', 'SENTRY_PROJECT_ID', 'SENTRY_RELEASE', 'SENTRY_ENVIRONMENT', 'SENTRY_CLIENT_SECRET', 'APP_VERSION', 'DD_ENV'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
let testTime = Date.now();
beforeEach(() => { jest.clearAllMocks(); Sentry.captureException.mockReturnValue(sentryEventId); keys.forEach(k => delete process.env[k]); testTime += 60_001; jest.spyOn(Date, 'now').mockReturnValue(testTime); });
afterAll(() => jest.restoreAllMocks());
afterAll(() => keys.forEach(k => { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }));

test('registers the customer using the existing vertical convention', () => {
  const { getCustomerConfig, listAliases } = require('../config/customers');
  expect(getCustomerConfig('a4c19e72').label).toContain('Lowe');
  expect(listAliases()['lowes']).toBe('a4c19e72');
  service.CATALOG.forEach(p => expect(fs.existsSync(path.join(__dirname, '../app/public', p.image))).toBe(true));
});

test('storefront uses the supplied logo and local licensed fonts without a sign-in flow', () => {
  const publicDir = path.join(__dirname, '../app/public');
  const html = fs.readFileSync(path.join(publicDir, 'verticals/a4c19e72.html'), 'utf8');
  expect(html).toContain('<img src="/verticals/lowes-assets/lowes-logo.png" alt="Lowe’s"');
  expect(html).not.toContain('<text x="65"');
  expect(html).toContain('Demo only · Synthetic shopping cart');
  expect(html).toContain('Guest demo · No sign-in');
  expect(html).not.toContain('type="password"');
  for (const asset of ['lowes-logo.png', 'Poppins-Regular.ttf', 'Poppins-SemiBold.ttf', 'OFL.txt']) {
    expect(fs.statSync(path.join(publicDir, 'verticals/lowes-assets', asset)).size).toBeGreaterThan(0);
  }
  expect(fs.readFileSync(path.join(publicDir, 'verticals/lowes-assets/OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
});

test('delivery succeeds with server-owned prices and no real order side effect', () => {
  const result = service.quoteCart({ items: [{ ...fridge, price: 1 }, battery] });
  expect(result).toMatchObject({ demo: true, success: true, subtotal: 1798, fee: 79, tax: 130.36, total: 2007.36 });
  expect(result.confirmation).toMatch(/^DEMO-/);
  expect(axios.post).not.toHaveBeenCalled();
});

test('parcel-only pickup is a healthy control at either store', () => {
  service.STORES.forEach(store => expect(service.quoteCart({ items: [battery], fulfillment: 'pickup', store })).toMatchObject({ success: true, store, subtotal: 199, fee: 0, total: 213.43 }));
});

test('incident baseline reproduces missing bulky pickup policy without losing cart data', () => {
  const cart = { items: [fridge, battery], fulfillment: 'delivery' };
  expect(service.quoteCart(cart).success).toBe(true);
  cart.fulfillment = 'pickup';
  expect(() => service.quoteCart(cart)).toThrow("Cannot read properties of undefined (reading 'fee')");
  expect(cart.items).toEqual([fridge, battery]);
});

test.each([
  {}, { items: [] }, { items: [null] }, { items: [{ sku: '__proto__', qty: 1 }] },
  { items: [fridge, fridge] }, { items: [{ ...fridge, qty: 0 }] }, { items: [{ ...fridge, qty: 1.5 }] },
  { items: [{ ...fridge, qty: 6 }] }, { items: [fridge], fulfillment: '__proto__' }, { items: [fridge], store: 'Mars' },
])('invalid carts fail before creating any incident: %p', cart => {
  expect(() => service.quoteCart(cart)).toThrow();
  try { service.quoteCart(cart); } catch (error) { expect(error.status).toBe(400); }
  expect(axios.post).not.toHaveBeenCalled();
});

test('default rehearsal previews the same checkout Teams card without send or session', async () => {
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  const result = await report({ store: 'South Charlotte', fulfillment: 'pickup' });
  expect(result).toMatchObject({ ok: true, dryRun: true, sent: false, destination: 'teams' });
  expect(result.payload.attachments[0].content).toEqual(result.card);
  expect(result.payload.text).toContain('Sentry Alert — Lowe’s Checkout Error');
  expect(result.payload.text).not.toContain('Responder instructions');
  expect(result.payload.text).not.toContain('scenario branch');
  expect(result.card.body.find(block => block.type === 'ActionSet').actions.map(action => action.title))
    .toEqual(['Watch Devin', 'View in Sentry', 'View in Datadog']);
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test('hosted mode captures Sentry and uses the existing Teams transport without an app-created session', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://shared.webhook.office.com/workflows/other-demos';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  const result = await report({ devinOrgId: 'org-selected', devinUserId: 'user-selected', devinEmail: 'presenter@example.com', store: 'Central Charlotte', fulfillment: 'pickup' });
  expect(result).toMatchObject({ ok: true, sent: true, dryRun: false, responderManaged: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post).toHaveBeenCalledWith(process.env.LOWES_TEAMS_WEBHOOK_URL, expect.objectContaining({ type: 'message' }), expect.objectContaining({ maxRedirects: 0 }));
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(postBugReportToTriage).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
  expect(scheduleVulnerablePR).not.toHaveBeenCalled();
  expect(Sentry.captureException).toHaveBeenCalledWith(error, {
    tags: { route: '/api/a4c19e72/checkout', service: 'customer-a4c19e72-checkout', scenario: 'lowes-cart-demo', alert_path: 'instant' },
    extra: { store: 'Central Charlotte', fulfillment: 'pickup' },
  });
  expect(Sentry.captureException.mock.invocationCallOrder[0]).toBeLessThan(axios.post.mock.invocationCallOrder[0]);
  expect(axios.post.mock.calls[0][1].text).toContain('presenter@example.com');
  const watchAction = axios.post.mock.calls[0][1].attachments[0].content.body.find(block => block.type === 'ActionSet').actions.find(action => action.title === 'Watch Devin');
  expect(watchAction.url).toBe('https://devin-gtm.devinenterprise.com/org/eashan-dev/automations/80bea729c76642c08bf5f12a610c9857');
  const sentryAction = axios.post.mock.calls[0][1].attachments[0].content.body.find(block => block.type === 'ActionSet').actions.find(action => action.title === 'View in Sentry');
  expect(new URL(sentryAction.url).searchParams.get('query')).toBe(sentryEventId);
});

test('alert metadata follows the standard Sentry card and carries the supplied identity', () => {
  process.env.SENTRY_ORG_SLUG = 'devin-gtm';
  process.env.SENTRY_PROJECT_ID = '123';
  process.env.SENTRY_RELEASE = 'checkout@test';
  process.env.DD_ENV = 'staging';
  const identity = { devinOrgId: 'org-selected', devinUserId: 'user-selected', devinEmail: 'presenter@example.com' };
  const data = buildAlertData(error, identity);
  expect(data).toMatchObject({ ...identity, release: 'checkout@test', environment: 'staging' });
  const issueUrl = new URL(data.issueUrl);
  expect(issueUrl.origin).toBe('https://devin-gtm.sentry.io');
  expect(issueUrl.searchParams.get('project')).toBe('123');
  expect(issueUrl.searchParams.get('query')).toBe('service:customer-a4c19e72-checkout route:/api/a4c19e72/checkout');
  expect(data).not.toHaveProperty('promptAppendix');
  const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
  expect(isInstantPathEvent({ tags: data.tags })).toBe(true);
});

test('dry-run payload equals the real pipeline payload except the captured Sentry event link', async () => {
  const preview = await report();
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  await report();
  const previewQuery = new URL(buildAlertData(error).issueUrl).searchParams.get('query');
  const normalized = value => JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<timestamp>').replaceAll(sentryEventId, encodeURIComponent(previewQuery));
  expect(normalized(axios.post.mock.calls[0][1])).toEqual(normalized(preview.payload));
});

test('card release and environment use the same defaults as Sentry capture', () => {
  expect(buildAlertData(error)).toMatchObject({ release: 'acme-checkout@1.0.0', environment: 'prod' });
  process.env.APP_VERSION = '2.0.0';
  process.env.DD_ENV = 'staging';
  expect(buildAlertData(error)).toMatchObject({ release: 'acme-checkout@2.0.0', environment: 'staging' });
  process.env.SENTRY_RELEASE = 'checkout@override';
  process.env.SENTRY_ENVIRONMENT = 'demo';
  expect(buildAlertData(error)).toMatchObject({ release: 'checkout@override', environment: 'demo' });
});

test.each([undefined, 'https://not-teams.example/test'])('missing/invalid Teams config cannot fall back to Slack: %p', async webhook => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://shared.webhook.office.com/workflows/other-demos';
  if (webhook) process.env.LOWES_TEAMS_WEBHOOK_URL = webhook;
  expect(await report()).toMatchObject({ ok: true, dryRun: true, sent: false, reason: 'missing-teams-target' });
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

test.each(['slack', null])('live mode respects saved destination and refuses Slack: %p', async destination => {
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  expect(await runWithAlertDestination(destination, () => reportCheckoutError(error))).toMatchObject({ ok: false, sent: false });
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
});

test('failed Teams transport does not send Slack or start an app-side session', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockRejectedValue(new Error('Mock Teams unavailable'));
  expect(await report()).toMatchObject({ ok: false, sent: false });
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test.each([
  ['test', undefined, undefined, 'local-or-test-runtime'],
  ['development', undefined, undefined, 'local-or-test-runtime'],
  ['production', 'true', undefined, 'ci-runtime'],
  ['production', undefined, 'true', 'explicit-dry-run'],
])('safe rehearsal in %s / CI=%s / explicit=%s even with a valid target', async (runtime, ci, dryRun, reason) => {
  process.env.NODE_ENV = runtime;
  if (ci) process.env.CI = ci;
  if (dryRun) process.env.LOWES_DEMO_DRY_RUN = dryRun;
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  expect(await report()).toMatchObject({ dryRun: true, sent: false, reason });
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
});

test('concurrent and repeated live failures are capped, including failed delivery attempts', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockRejectedValue(new Error('Mock transport down'));
  const results = await Promise.all([report(), report(), report()]);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(results.filter(r => r.throttled)).toHaveLength(2);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  Date.now.mockReturnValue(testTime + 60_001);
  axios.post.mockResolvedValue({ status: 202 });
  expect(await report()).toMatchObject({ sent: true });
  expect(axios.post).toHaveBeenCalledTimes(2);
  expect(Sentry.captureException).toHaveBeenCalledTimes(2);
});

describe('HTTP surface', () => {
  let server, base;
  beforeAll(async () => { const app = express(); app.use(express.json()); app.use((req, res, next) => runWithAlertDestination(alertDestinationFromCookie(req.headers.cookie), next)); app.use(router); app.use(require('../app/routes/sentry-webhook')); server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  test('catalog is synthetic and bespoke send endpoint does not exist', async () => {
    const response = await fetch(`${base}/api/a4c19e72/catalog`);
    expect((await response.json()).products).toHaveLength(3);
    const denied = await fetch(`${base}/api/a4c19e72/teams/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(404);
  });
  test('healthy checkout returns 200; invalid cart returns 400', async () => {
    for (const [items, status] of [[[battery], 200], [[], 400]]) {
      const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, fulfillment: 'pickup' }) });
      expect(response.status).toBe(status);
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
  test('failing checkout itself creates preview; no second client trigger is needed', async () => {
    const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [fridge, battery], fulfillment: 'pickup', store: 'South Charlotte' }) });
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.alert).toMatchObject({ ok: true, dryRun: true, sent: false });
    expect(data.alert.payload.text).toContain('View in Sentry');
    expect(data.alert.payload.text).not.toContain('Responder instructions');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
  test('checkout carries persisted Teams cookie to the existing transport', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
    axios.post.mockResolvedValue({ status: 202 });
    const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'alert_destination=teams' }, body: JSON.stringify({ items: [fridge], fulfillment: 'pickup' }) });
    expect(response.status).toBe(500);
    expect((await response.json()).alert).toMatchObject({ ok: true, sent: true, responderManaged: true });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test.each([
    { action: 'triggered', data: { event: { title: error.message, tags: [['alert_path', 'instant']] } } },
    ...['app/services/verticals/a4c19e72.js in quoteCart', 'quoteCart(app.services.verticals.a4c19e72)'].map(culprit => ({ action: 'created', data: { issue: { id: 'lowes-demo', title: error.message, culprit } } })),
  ])('Sentry event/issue webhooks do not duplicate the Lowe’s alert: %j', async payload => {
    const response = await fetch(`${base}/webhooks/sentry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: true, reason: 'instant_path' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(postBugReportToTriage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});

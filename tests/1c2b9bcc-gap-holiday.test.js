jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn(), addEventProcessor: jest.fn() };
      callback(scope);
      return scope;
    }),
  },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  GAP_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  APP_CULPRIT,
  ERROR_CODE,
  REPORT_PATH,
  isAppReport,
} = require('../app/services/verticals/gap');
const router = require('../app/routes/verticals/gap');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/1c2b9bcc');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '1c2b9bcc.html'), 'utf8');

const WEB_REPORT = {
  source: 'gap/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'ProductPage',
  action: 'openProduct',
  errorType: 'SizeChartError.sizeChartNotFound',
  errorMessage: 'No size chart for code MENS_KNIT_RIB_RELAXED (product 914524042, CashSoft Rib Quarter-Zip Sweater)',
  errorCode: 'GAP-PDP-4041',
  productId: '914524042',
  productName: 'CashSoft Rib Quarter-Zip Sweater',
  sizeChartCode: 'MENS_KNIT_RIB_RELAXED',
  category: 'The Holiday Collection',
  catalogVersion: '2026.11',
  appVersion: '2026.11.0',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's product page rules (no DOM) so the planted defect is tested as code. */
function loadPdpRules() {
  const rules = PAGE.slice(PAGE.indexOf('/* SIZE_CHARTS:start'), PAGE.indexOf('/* SIZE_CHARTS:end */'));
  const sandbox = {};
  vm.runInNewContext(`${rules}\nthis.CATALOG = CATALOG; this.buildProductPage = buildProductPage; this.SizeChartError = SizeChartError; this.ProductNotFoundError = ProductNotFoundError;`, sandbox);
  return sandbox;
}

async function postJson(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${REPORT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('Gap Holiday Collection replica (/gap-holiday)', () => {
  test('is reachable at the friendly aliases without taking the legacy /gap alias', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['gap-holiday']));
    expect(customer.aliases).not.toContain('gap');
  });

  test('walks Home -> The Holiday Collection -> product page', () => {
    expect(PAGE).toContain('<html lang="en">');
    expect(PAGE).toContain('id="shopHoliday"');
    expect(PAGE).toContain('<h1>The Holiday Collection</h1>');
    expect(PAGE).toContain('id="addToBag"');
    expect(PAGE).toContain('id="pdpError"');
  });

  test('reports with the Gap client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/gap/pdp/error';");
    expect(PAGE).toContain("source: 'gap/web'");
    expect(PAGE).toContain("service: 'customer-gap'");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('is labelled as a mock not affiliated with Gap', () => {
    expect(PAGE).toContain('class="mockbar"');
    expect(PAGE).toContain('THIS IS A MOCK');
    expect(PAGE).toContain('not affiliated with Gap Inc.');
  });

  test('every other Holiday Collection product opens with its sizes', () => {
    const { CATALOG, buildProductPage } = loadPdpRules();
    expect(CATALOG).toHaveLength(12);
    CATALOG.filter((p) => p.pid !== '914524042').forEach((p) => {
      expect(buildProductPage(p.pid).sizes.length).toBeGreaterThan(0);
    });
    expect(buildProductPage('908078012').sizes).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
  });

  test('an unknown product id is not a size chart failure', () => {
    const { buildProductPage, ProductNotFoundError } = loadPdpRules();
    expect(() => buildProductPage('000000000')).toThrow(ProductNotFoundError);
  });

  test('keeps the planted defect: the CashSoft Rib Quarter-Zip Sweater has no size chart', () => {
    const { buildProductPage, SizeChartError } = loadPdpRules();
    let error;
    try { buildProductPage('914524042'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SizeChartError);
    expect(error.message).toBe('No size chart for code MENS_KNIT_RIB_RELAXED (product 914524042, CashSoft Rib Quarter-Zip Sweater)');
    expect(error.code).toBe(ERROR_CODE);
  });
});

describe('Gap product page failure report bridge', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, done);
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('accepts web, ios and android sources only', () => {
    expect(isAppReport(WEB_REPORT)).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'gap/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'gap/android' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'gap/windows' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-bank-millennium' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'bank-millennium/web' });
    expect(status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('raises one Slack alert that starts a Linux orchestrator', async () => {
    const { status, body } = await postJson(server, WEB_REPORT);
    expect(status).toBe(202);
    expect(body).toMatchObject({ received: true, service: APP_SERVICE, sessionRequested: true });

    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      service: APP_SERVICE,
      customer: '1c2b9bcc',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[Gap] ${ERROR_CODE} product page failed for CashSoft Rib Quarter-Zip Sweater 914524042 (web)`,
    });
    expect(alertData.extra).toMatchObject({ productId: '914524042', sizeChartCode: 'MENS_KNIT_RIB_RELAXED', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Android reports as Android', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'gap/android', platform: 'android' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('Gap — Holiday Collection product page (Android)');
  });

  test('the orchestrator prompt routes each platform to the right VM and folder', () => {
    expect(GAP_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios` \(`GapCore\/`, `GapMobile\/` only\)/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/android-demos` \(`apps\/1c2b9bcc\/` only\)/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/create THREE child/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    const directive = APP_REMEDIATION_DIRECTIVE;
    expect(directive.indexOf('Devin session link')).toBeLessThan(directive.indexOf('1. Diagnose'));
  });
  test('tagless Sentry issues for every Gap client take the instant path', () => {
    ['gap/web ProductPage openProduct', 'gap/ios ProductPage openProduct', 'gap/android ProductPage openProduct', APP_CULPRIT]
      .forEach((culprit) => expect(isInstantPathEvent({ culprit, tags: [] })).toBe(true));
  });

  test('caps reports per window', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await postJson(server, WEB_REPORT)).status);
    }
    expect(statuses).toContain(429);
    expect(statuses[statuses.length - 1]).toBe(429);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls.length).toBe(statuses.filter((s) => s === 202).length);
  });
});

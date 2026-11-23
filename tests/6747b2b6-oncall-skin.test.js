jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { Sentry } = require('../app/telemetry/sentry');
const { BENCHMARKS, LATENCY_BUDGET_MS } = require('../app/services/oncall-verticals/commodityprices');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

beforeEach(() => Sentry.captureException.mockClear());

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TITLE = 'Price Assessments | Commodity Insights | S&P Global';
const API = '/api/oncall/commodityprices/assessments';

describe('6747b2b6 S&P Global Commodity Insights latency on-call skin', () => {
  test('is a native, Teams-routed commodityprices skin with a metric-shaped alert', () => {
    const skin = getOncallSkin('6747b2b6');
    expect(skin).toMatchObject({
      company: 'S&P Global', vertical: 'commodityprices', oncallOnly: true, teamsAlerts: true, alertDestination: 'teams', page: { file: '6747b2b6.html' },
    });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY AN S&P GLOBAL SITE/);
    const scenario = ALERT_SCENARIOS.commodityprices;
    expect(scenario).toMatchObject({
      apiPath: '/api/6747b2b6/assessments', oncallApiPath: API, triggerWhen: { sector: 'crude-oil' }, retryWindow: true, defaultAlertDestination: 'teams', unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin.alertCard)).not.toMatch(/\.js|TypeError|loadHistories|readAssessmentHistory|PRICE_STORE/i);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/6747b2b6', '/6747b2b6', '/spgi-commodities', '/sp-commodity-latency'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    pages.slice(1).forEach((page) => expect(page).toEqual(pages[0]));
    expect(pages[0]).toContain(`<title>${TITLE}</title>`);
    expect(pages[0]).toContain('NOT ACTUALLY AN S&P GLOBAL SITE');
    expect(pages[0]).toContain(`const oncallApiPath = ${JSON.stringify(API)}`);
  });

  test('Crude Oil grid returns correct prices but breaches the latency budget', async () => {
    const started = Date.now();
    const res = await post(API, { sector: 'crude-oil' });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, sector: 'Crude Oil', assessedOn: '2026-11-20' });
    expect(body.assessments).toHaveLength(BENCHMARKS.filter((b) => b.sector === 'crude-oil').length);
    expect(body.assessments[0]).toMatchObject({ symbol: 'PCAAS00', name: 'Dated Brent', close: 74.66, change: 0.64 });
    expect(body.assessments[0].history).toHaveLength(5);
    expect(elapsed).toBeGreaterThan(LATENCY_BUDGET_MS);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CommodityLatencyBudgetExceeded' }),
      expect.objectContaining({ tags: expect.objectContaining({ route: API, sector: 'crude-oil' }) }),
    );
  }, 15000);

  test('smaller sectors stay within budget', async () => {
    const started = Date.now();
    const res = await post(API, { sector: 'lng' });
    expect(res.status).toBe(200);
    expect((await res.json()).assessments).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(LATENCY_BUDGET_MS);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('unknown sector is rejected with 400', async () => {
    const res = await post(API, { sector: 'gold' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_SECTOR' });
  });
});

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

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const API = '/api/oncall/research/answers';

describe('e62af577 native research app on-call skin', () => {
  test('is a native-app research skin without page, report or incident surfaces', () => {
    const skin = getOncallSkin('e62af577');
    expect(skin).toMatchObject({ vertical: 'research', oncallOnly: true, alertDestination: 'slack' });
    expect(skin.page).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A ROGO APP/);
    const scenario = ALERT_SCENARIOS.research;
    expect(scenario).toMatchObject({ oncallApiPath: API, service: 'research-api', unlisted: true });
    const copy = JSON.stringify(scenario) + JSON.stringify(skin);
    expect(copy).not.toMatch(/licen[cs]e|provision/i);
    expect(copy).not.toMatch(/\.js|pullDocuments|fetchFilingText|DOCUMENT_FETCH|sequential|in series/i);
  });

  test('has no customer page: /oncall/c/e62af577, /report and /incident 404', async () => {
    for (const suffix of ['', '/report', '/incident']) {
      const res = await fetch(`${baseUrl}/oncall/c/e62af577${suffix}`);
      expect(res.status).toBe(404);
    }
  });

  test('rejects an empty question and an unknown ticker with 400 INVALID_QUERY', async () => {
    let res = await post(API, { query: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_QUERY');
    res = await post(API, { query: 'Latest filings', tickers: ['ZZZZ'] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_QUERY');
  });

  test('answers a single-source question with citations', async () => {
    const res = await post(API, { query: 'Latest NVIDIA proxy', tickers: ['NVDA'], sources: ['DEF 14A'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, tickers: ['NVDA'] });
    expect(body.answerId).toMatch(/^ans_/);
    expect(body.documents.every((d) => d.docType === 'DEF 14A')).toBe(true);
    expect(body.answer.citations.length).toBeGreaterThan(0);
    for (const bullet of body.answer.bullets) {
      for (const id of bullet.citations) {
        expect(body.answer.citations.some((c) => c.id === id)).toBe(true);
      }
    }
  });

  test('cites only requested filing types and covers every ticker', async () => {
    const res = await post(API, { query: 'Compare recent filings', tickers: ['NVDA', 'AAPL'], sources: ['DEF 14A'] });
    expect(res.status).toBe(200);
    const { answer } = await res.json();
    expect(answer.citations.every((c) => c.docType === 'DEF 14A')).toBe(true);
    expect(new Set(answer.citations.map((c) => c.ticker))).toEqual(new Set(['NVDA', 'AAPL']));
    expect(answer.title).toContain('Compare recent filings');
  });

  test('a single-type request does not reuse the curated multi-source summary', async () => {
    const res = await post(API, { query: 'Latest insider filings', tickers: ['NVDA'], sources: ['Form 4'] });
    const { answer } = await res.json();
    expect(answer.citations.every((c) => c.docType === 'Form 4')).toBe(true);
    expect(answer.summary).not.toMatch(/10-Q|margin/i);
  });
});

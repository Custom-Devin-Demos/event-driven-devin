/* global describe, expect, test, jest, beforeEach */

process.env.VALUATION_LOOKUP_MS_62B9367B = '15';

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { alertStrings } = require('../app/services/alert-locale');
const customerConfig = require('../config/customers/62b9367b');
const { ONCALL_SKINS } = require('../config/oncall-skins');
const assetCentralRoutes = require('../app/routes/verticals/62b9367b');
const {
  CORPORATE_PORTFOLIO_ID,
  MARK_LOOKUP_MS,
  Money,
  NIGHTLY_POSITION,
  listPortfolios,
  openPortfolio,
  resetDemoState,
  runPositionsLoad,
  valueHoldings,
} = require('../app/services/verticals/62b9367b');

function request(method, path, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(assetCentralRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          });
        },
      );
      req.on('error', (error) => {
        server.close();
        reject(error);
      });
      req.end(payload);
    });
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetDemoState();
  createSessionAndAlert.mockClear();
});

describe('62b9367b AssetCentral config', () => {
  test('is an unlisted native skin with a hex slug and pgim alias', () => {
    const skin = ONCALL_SKINS['62b9367b'];
    expect(skin.slug).toBe('62b9367b');
    expect(skin.page.file).toBe('62b9367b.html');
    expect(skin.hideRibbon).toBe(true);
    expect(customerConfig.aliases).toEqual(expect.arrayContaining(['pgim']));
    expect(alertStrings(customerConfig.locale)).toBeTruthy();
  });
});

describe('62b9367b portfolio dashboard', () => {
  test('lists the seeded portfolios with snapshot values', async () => {
    const res = await request('GET', '/api/62b9367b/portfolios');
    expect(res.status).toBe(200);
    expect(res.body.portfolios.map((p) => p.id)).toEqual(['PRE-USCORE', 'PRE-EUVA3', 'PRE-APLOG', CORPORATE_PORTFOLIO_ID]);
    for (const portfolio of res.body.portfolios) {
      expect(portfolio.marketValue).toBeGreaterThan(0);
      expect(portfolio.status).toBe('Valued');
    }
  });

  test('opens a portfolio with holdings, weights, carbon card and audit history', async () => {
    const res = await request('GET', `/api/62b9367b/portfolios/${CORPORATE_PORTFOLIO_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.holdings).toHaveLength(18);
    const weights = res.body.holdings.reduce((sum, h) => sum + h.weight, 0);
    expect(weights).toBeCloseTo(1, 6);
    expect(res.body.holdings[0]).toEqual(expect.objectContaining({ asset: expect.any(String), propertyType: expect.any(String), marketValue: expect.any(Number) }));
    expect(res.body.carbon).toEqual(expect.objectContaining({ asOfMonth: 'Sep 2026', override: null }));
    expect(res.body.carbon.waci).toBeGreaterThan(0);
    expect(res.body.carbon.coveragePct).toBeGreaterThan(90);
    expect(res.body.carbon.coveragePct).toBeLessThan(100);
    expect(res.body.audit.length).toBeGreaterThan(0);
  });

  test('returns 404 for an unknown portfolio without alerting', async () => {
    const res = await request('GET', '/api/62b9367b/portfolios/NOPE');
    expect(res.status).toBe(404);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('62b9367b carbon intensity override', () => {
  test('requires a reason', async () => {
    const res = await request('POST', '/api/62b9367b/portfolios/PRE-USCORE/carbon-override', { value: 120, reason: ' ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('rejects an invalid value', async () => {
    const res = await request('POST', '/api/62b9367b/portfolios/PRE-USCORE/carbon-override', { value: 'abc', reason: 'Vendor restatement received' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE');
  });

  test('accepts a zero intensity override', async () => {
    const res = await request('POST', '/api/62b9367b/portfolios/PRE-APLOG/carbon-override', { value: 0, reason: 'All assets on verified renewable supply' });
    expect(res.status).toBe(200);
    expect(res.body.override.value).toBe(0);
  });

  test('records the override and an audit entry', async () => {
    const reason = 'Vendor restated scope 2 emissions for one asset';
    const res = await request('POST', '/api/62b9367b/portfolios/PRE-USCORE/carbon-override', { value: 120.04, reason, user: 'Someone Else' });
    expect(res.status).toBe(200);
    expect(res.body.override).toEqual(expect.objectContaining({ value: 120, reason, by: 'A. Rivera' }));
    expect(res.body.audit[0]).toEqual(expect.objectContaining({ action: 'Carbon intensity override', actor: 'A. Rivera' }));

    const detail = await request('GET', '/api/62b9367b/portfolios/PRE-USCORE');
    expect(detail.body.carbon.waci).toBe(120);
    expect(detail.body.carbon.computedWaci).not.toBe(120);
  });
});

describe('62b9367b nightly positions load', () => {
  test('inserts one unpriced holding into the corporate portfolio only, once', async () => {
    const first = await request('POST', '/api/62b9367b/positions-load');
    expect(first.status).toBe(200);
    expect(first.body.inserted).toBe(1);
    expect(NIGHTLY_POSITION.marketValue).toBeNull();

    const second = await request('POST', '/api/62b9367b/positions-load');
    expect(second.body.inserted).toBe(0);

    const list = listPortfolios().portfolios;
    const corp = list.find((p) => p.id === CORPORATE_PORTFOLIO_ID);
    expect(corp.holdingsCount).toBe(19);
    expect(corp.status).toBe('Positions updated');
    expect(list.filter((p) => p.id !== CORPORATE_PORTFOLIO_ID).every((p) => p.status === 'Valued')).toBe(true);
  });

  test('opening the corporate portfolio afterwards revalues serially and fails with a 500 TypeError', async () => {
    runPositionsLoad();
    const started = Date.now();
    const res = await request('GET', `/api/62b9367b/portfolios/${CORPORATE_PORTFOLIO_ID}`, null, {
      'x-devin-user-id': 'clerk-user_demo',
      'x-devin-org-id': 'org_demo',
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(res.body.error).toBe("unsupported operand type(s) for +: 'Money' and 'null'");
    expect(res.body.code).toBe('PORTFOLIO_UNAVAILABLE');
    expect(res.body.reference).toMatch(/^AC-[0-9A-F]{8}$/);
    expect(elapsed).toBeGreaterThanOrEqual(19 * MARK_LOOKUP_MS - 20);
  });

  test('the failure raises one instant alert through createSessionAndAlert', async () => {
    runPositionsLoad();
    await request('GET', `/api/62b9367b/portfolios/${CORPORATE_PORTFOLIO_ID}`, null, {
      'x-devin-user-id': 'clerk-user_demo',
      'x-devin-org-id': 'org_demo',
    });
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      customer: '62b9367b',
      errorType: 'TypeError',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      service: 'assetcentral-portfolio-api',
    }));
    expect(payload.promptAppendix).toContain('app/services/verticals/62b9367b.js');

    await request('GET', `/api/62b9367b/portfolios/${CORPORATE_PORTFOLIO_ID}`);
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('other portfolios keep opening after the load', async () => {
    runPositionsLoad();
    await expect(openPortfolio(CORPORATE_PORTFOLIO_ID)).rejects.toThrow(TypeError);
    for (const id of ['PRE-USCORE', 'PRE-EUVA3', 'PRE-APLOG']) {
      const res = await request('GET', `/api/62b9367b/portfolios/${id}`);
      expect(res.status).toBe(200);
    }
  });

  test('the positions feed keeps the time the batch actually ran', async () => {
    await request('POST', '/api/62b9367b/positions-load');
    const first = await request('GET', '/api/62b9367b/portfolios');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await request('GET', '/api/62b9367b/portfolios');
    expect(first.body.positionsFeed.lastLoadAt).not.toBe('2026-10-28T06:10:00Z');
    expect(second.body.positionsFeed.lastLoadAt).toBe(first.body.positionsFeed.lastLoadAt);
  });

  test('reset restores the seeded portfolio', async () => {
    runPositionsLoad();
    const reset = await request('POST', '/api/62b9367b/reset');
    expect(reset.status).toBe(200);
    const res = await request('GET', `/api/62b9367b/portfolios/${CORPORATE_PORTFOLIO_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.holdings).toHaveLength(18);
  });
});

describe('62b9367b Money', () => {
  test('adding a missing value raises the TypeError', () => {
    expect(() => Money.zero().add(null)).toThrow("unsupported operand type(s) for +: 'Money' and 'null'");
    expect(Money.usd(1.25).add(Money.usd(2.5)).toNumber()).toBe(3.75);
  });

  test('valueHoldings weights priced holdings', () => {
    const snapshot = valueHoldings(
      [{ assetId: 'a', marketValue: 75, emissionsTco2e: 10, revenueUsdM: 1 }, { assetId: 'b', marketValue: 25, emissionsTco2e: null, revenueUsdM: 1 }],
      [{ marketValue: 75 }, { marketValue: 25 }],
    );
    expect(snapshot.totalMarketValue).toBe(100);
    expect(snapshot.holdings.map((h) => h.weight)).toEqual([0.75, 0.25]);
    expect(snapshot.carbon).toEqual(expect.objectContaining({ waci: 10, coveragePct: 75 }));
  });
});

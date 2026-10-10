/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const portfolioRoutes = require('../app/routes/verticals/0fb68d91');
const {
  searchPortfolio,
  buildStrategySpotlight,
  FILTER_OPTIONS,
  STRATEGY_PROFILES,
  PAGE_SIZE,
} = require('../app/services/verticals/0fb68d91');
const PORTFOLIO = require('../app/services/verticals/0fb68d91-portfolio.json');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'analyst@permira.example',
};

function postSearch(body) {
  const app = express();
  app.use(express.json());
  app.use(portfolioRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/0fb68d91/portfolio/search',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

afterEach(() => {
  delete STRATEGY_PROFILES['energy transition'];
  createSessionAndAlert.mockClear();
});

describe('Permira portfolio data', () => {
  test('carries every company from the public Our Portfolio page with known filter values', () => {
    expect(PORTFOLIO).toHaveLength(110);
    for (const company of PORTFOLIO) {
      expect(company.logo).toMatch(/^https:\/\/media\.permira\.com\//);
      expect(company.path).toMatch(/^\/portfolio\/our-portfolio\//);
      company.regions.forEach((region) => expect(FILTER_OPTIONS.countryRegion).toContain(region));
      company.strategies.forEach((strategy) => expect(FILTER_OPTIONS.strategy).toContain(strategy));
      company.sectors.forEach((sector) => expect(FILTER_OPTIONS.sectors).toContain(sector));
      expect(FILTER_OPTIONS.status).toContain(company.status);
    }
  });
});

describe('Permira portfolio search', () => {
  test('returns the first page of all companies in latest order', async () => {
    const result = await searchPortfolio({ ...IDENTITY });

    expect(result.success).toBe(true);
    expect(result.searchId).toMatch(/^PRM-[0-9A-F]{8}$/);
    expect(result.totalItems).toBe(110);
    expect(result.data).toHaveLength(PAGE_SIZE);
    expect(result.hasMore).toBe(true);
    expect(result.data[0].name).toBe(PORTFOLIO[0].name);
    expect(result.data[0].url).toBe(`https://www.permira.com${PORTFOLIO[0].path}`);
    expect(result.strategySpotlight).toEqual([]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['flagship', 70],
    ['ascent', 18],
    ['pgo1', 12],
  ])('filters the %s strategy and builds its spotlight', async (strategy, count) => {
    const result = await searchPortfolio({ filters: { strategy: [strategy] }, ...IDENTITY });

    expect(result.totalItems).toBe(count);
    expect(result.strategySpotlight).toEqual([
      expect.objectContaining({ strategy, label: STRATEGY_PROFILES[strategy].label, companyCount: count }),
    ]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('combines filters, keyword, sort and pagination', async () => {
    const sectors = await searchPortfolio({ filters: { sectors: ['healthcare'], status: ['current'] }, sort: 'a_z' });
    const names = sectors.data.map((company) => company.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    sectors.data.forEach((company) => {
      expect(company.sectors).toContain('Healthcare');
      expect(company.status).toBe('Current');
    });

    const keyword = await searchPortfolio({ keyword: 'zendesk' });
    expect(keyword.data.map((company) => company.name)).toEqual(['Zendesk']);

    const last = await searchPortfolio({ page: 5 });
    expect(last.data).toHaveLength(10);
    expect(last.hasMore).toBe(false);
  });

  test.each([
    [{ filters: { region: ['uk'] } }, 'INVALID_FILTERS'],
    [{ filters: { strategy: 'flagship' } }, 'INVALID_FILTERS'],
    [{ filters: { strategy: ['credit'] } }, 'INVALID_FILTERS'],
    [{ sort: 'newest' }, 'INVALID_SORT'],
    [{ page: -1 }, 'INVALID_PAGE'],
  ])('rejects %j with a 400 and no alert', async (body, code) => {
    const { status, body: response } = await postSearch(body);

    expect(status).toBe(400);
    expect(response.errorClass).toBe('ValidationError');
    expect(response.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Permira Energy Transition strategy filter', () => {
  test('has no strategy profile under the value the Strategy filter sends', () => {
    expect(FILTER_OPTIONS.strategy).toContain('energy transition');
    expect(STRATEGY_PROFILES['energy transition']).toBeUndefined();
    expect(() => buildStrategySpotlight(['energy transition'], [])).toThrow(TypeError);
  });

  test('raises a TypeError and forwards the hub identity to the alert flow', async () => {
    await expect(
      searchPortfolio({ filters: { strategy: ['energy transition'] }, ...IDENTITY }),
    ).rejects.toThrow("Cannot read properties of undefined (reading 'label')");

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('0fb68d91');
    expect(alert.service).toBe('customer-0fb68d91-portfolio-search');
    expect(alert.culprit).toBe('app/services/verticals/0fb68d91.js — buildStrategySpotlight');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('analyst@permira.example');
    expect(alert.slackMemberId).toBeUndefined();
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/0fb68d91/portfolio/search' },
      { key: 'strategy', value: 'energy transition' },
    ]));
  });

  test('returns a 500 response from the route', async () => {
    const { status, body } = await postSearch({ filters: { strategy: ['energy transition'] }, ...IDENTITY });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'label'\)/);
    expect(body.code).toBe('PORTFOLIO_SEARCH_FAILED');
  });
});

describe('Permira Energy Transition fixed behavior', () => {
  test('returns an empty result with a spotlight once the strategy resolves to a profile', async () => {
    STRATEGY_PROFILES['energy transition'] = STRATEGY_PROFILES.energy_transition;

    const result = await searchPortfolio({ filters: { strategy: ['energy transition'] }, ...IDENTITY });

    expect(result.totalItems).toBe(0);
    expect(result.data).toEqual([]);
    expect(result.strategySpotlight).toEqual([
      expect.objectContaining({ label: 'Energy Transition', companyCount: 0 }),
    ]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

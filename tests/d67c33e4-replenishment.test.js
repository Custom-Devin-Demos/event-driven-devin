/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const replenishmentRoutes = require('../app/routes/verticals/d67c33e4');
const { getNetwork, PLANNING_HORIZONS } = require('../app/services/verticals/d67c33e4');
const { SITES, SKUS, SERVICE_TIERS, positionsForSite } = require('../app/services/verticals/d67c33e4-network');

const ALL_SITE_IDS = SITES.map((site) => site.id);

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(replenishmentRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

afterEach(() => {
  createSessionAndAlert.mockClear();
});

describe('stock control tower network data', () => {
  test('exposes every site with aggregated stock positions', () => {
    const network = getNetwork();

    expect(network.sites).toHaveLength(SITES.length);
    expect(network.skus).toHaveLength(SKUS.length);

    const castleDonington = network.sites.find((site) => site.id === 'NDC-CDON');
    const positions = positionsForSite('NDC-CDON');

    expect(castleDonington.onHand).toBe(positions.reduce((total, p) => total + p.onHand, 0));
    expect(castleDonington.available).toBe(castleDonington.onHand - castleDonington.allocated);
    expect(castleDonington.lat).toBeCloseTo(52.8306, 4);
    expect(castleDonington.lng).toBeCloseTo(-1.3181, 4);
    expect(['healthy', 'watch', 'at-risk']).toContain(castleDonington.health);
  });

  test('every site carries a service tier that resolves in the tier table', () => {
    const unresolved = SITES.filter((site) => !SERVICE_TIERS[site.serviceTier.toLowerCase().replace('_', '-')]);

    expect(unresolved).toEqual([]);
  });

  test('serves the network over the API with the supported planning horizons', async () => {
    const { status, body } = await call('GET', '/api/d67c33e4/network');

    expect(status).toBe(200);
    expect(body.sites).toHaveLength(SITES.length);
    expect(body.horizons.map((horizon) => horizon.days)).toEqual(
      Object.keys(PLANNING_HORIZONS).map(Number),
    );
  });
});

describe('replenishment run validation', () => {
  test('rejects a run with no sites selected', async () => {
    const { status, body } = await call('POST', '/api/d67c33e4/replenishment', {
      siteIds: [],
      horizonDays: 14,
    });

    expect(status).toBe(400);
    expect(body.code).toBe('NO_SITES_SELECTED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unknown site', async () => {
    const { status, body } = await call('POST', '/api/d67c33e4/replenishment', {
      siteIds: ['STR-MARB', 'STR-NOWHERE'],
      horizonDays: 14,
    });

    expect(status).toBe(400);
    expect(body.code).toBe('UNKNOWN_SITE');
    expect(body.error).toMatch(/STR-NOWHERE/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unsupported planning horizon', async () => {
    const { status, body } = await call('POST', '/api/d67c33e4/replenishment', {
      siteIds: ALL_SITE_IDS,
      horizonDays: 90,
    });

    expect(status).toBe(400);
    expect(body.code).toBe('HORIZON_UNSUPPORTED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a request with no JSON body', async () => {
    const { status, body } = await call('POST', '/api/d67c33e4/replenishment', undefined);

    expect(status).toBe(400);
    expect(body.code).toBe('NO_SITES_SELECTED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

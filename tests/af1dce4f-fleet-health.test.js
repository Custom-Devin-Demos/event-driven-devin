/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const routes = require('../app/routes/verticals/af1dce4f');
const {
  generateFleetHealthReport,
  resetWorkbench,
  getOverview,
  CUSTOMERS,
} = require('../app/services/verticals/af1dce4f');

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

describe('af1dce4f Fleet Health Report agent', () => {
  beforeEach(() => {
    resetWorkbench();
    jest.clearAllMocks();
  });

  test('overview opens nominal with three customers and no open incidents', () => {
    const overview = getOverview();
    expect(overview.status).toBe('nominal');
    expect(overview.customers).toHaveLength(3);
    expect(CUSTOMERS.map((c) => c.id)).toEqual(['AIR-A', 'AIR-B', 'LES-C']);
    expect(overview.summary.openIncidents).toBe(0);
    expect(overview.summary.redCells).toBe(0);
  });

  test('generates a ranked report for Airline A', async () => {
    const result = await generateFleetHealthReport({ customerId: 'AIR-A' });
    expect(result.success).toBe(true);
    expect(result.report.customerId).toBe('AIR-A');
    expect(result.report.engines).toHaveLength(6);
    expect(result.report.engines[0].esn).toBe('598-16116');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('generates a report for Lessor C', async () => {
    const result = await generateFleetHealthReport({ customerId: 'LES-C' });
    expect(result.success).toBe(true);
    expect(result.report.customerId).toBe('LES-C');
  });

  test('Airline B report fails, opens an incident and alerts Devin', async () => {
    await expect(generateFleetHealthReport({ customerId: 'AIR-B' })).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.service).toBe('af1dce4f-api');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.extra.customerId).toBe('AIR-B');

    const overview = getOverview();
    expect(overview.status).toBe('incident');
    expect(overview.summary.openIncidents).toBe(1);
    expect(overview.summary.redCells).toBe(1);
    const red = overview.grid.find((row) => row.agentId === 'fleet-health-report').cells.find((c) => c.state === 'red');
    expect(red.customerId).toBe('AIR-B');
  });

  test('route returns 500 with the runtime error for Airline B and 200 for Airline A', async () => {
    const failed = await request('POST', '/api/af1dce4f/fleet-health/report', { customerId: 'AIR-B' });
    expect(failed.status).toBe(500);
    expect(failed.body.errorType).toBe('TypeError');

    const ok = await request('POST', '/api/af1dce4f/fleet-health/report', { customerId: 'AIR-A' });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  });

  test('unknown customer is rejected with 400', async () => {
    const res = await request('POST', '/api/af1dce4f/fleet-health/report', { customerId: 'NOPE' });
    expect(res.status).toBe(400);
  });

  test('reset clears incidents and runs and the failure recurs afterwards', async () => {
    await expect(generateFleetHealthReport({ customerId: 'AIR-B' })).rejects.toThrow(TypeError);
    expect(getOverview().summary.openIncidents).toBe(1);

    const reset = await request('POST', '/api/af1dce4f/fleet-health/reset');
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ success: true, cleared: 2, status: 'nominal' });
    expect(getOverview().status).toBe('nominal');
    expect(getOverview().runs).toHaveLength(0);

    await expect(generateFleetHealthReport({ customerId: 'AIR-B' })).rejects.toThrow(TypeError);
    expect(getOverview().summary.openIncidents).toBe(1);
  });
});

describe('af1dce4f incident de-duplication', () => {
  test('repeat Airline B failures reuse the open incident', async () => {
    resetWorkbench();
    await expect(generateFleetHealthReport({ customerId: 'AIR-B' })).rejects.toThrow(TypeError);
    await expect(generateFleetHealthReport({ customerId: 'AIR-B' })).rejects.toThrow(TypeError);
    const overview = getOverview();
    expect(overview.summary.openIncidents).toBe(1);
    expect(overview.incidents[0].occurrences).toBe(2);
    expect(overview.runs).toHaveLength(2);
    resetWorkbench();
  });
});

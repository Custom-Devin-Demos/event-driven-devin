/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const chartRoutes = require('../app/routes/verticals/5826f4f2');
const {
  runChartQuery,
  resolveRollupWindow,
  buildChartSeries,
  ROLLUP_WINDOWS,
} = require('../app/services/verticals/5826f4f2');

const VALID_QUERY = {
  projectId: 'prj_growth_analytics_prod',
  eventName: 'checkout_completed',
  chartType: 'event_segmentation',
  interval: 'monthly',
  segmentBy: 'None',
  lookbackDays: 90,
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'alex.morgan@growthlabs.example',
};

const MONTHLY_ROLLUP = {
  bucketMs: 30 * 24 * 3600000,
  maxBuckets: 36,
  table: 'events_monthly',
};

function postQuery(body) {
  const app = express();
  app.use(express.json());
  app.use(chartRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/5826f4f2/chart-query',
          method: 'POST',
          headers,
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
  delete ROLLUP_WINDOWS.event_segmentation.monthly;
  createSessionAndAlert.mockClear();
});

describe('Amplitude chart query rollups', () => {
  test('runs a registered event segmentation interval', async () => {
    const result = await runChartQuery({ ...VALID_QUERY, interval: 'weekly' });

    expect(result.success).toBe(true);
    expect(result.queryId).toMatch(/^AMP-[0-9A-F]{8}$/);
    expect(result.chart.type).toBe('Event Segmentation');
    expect(result.chart.interval).toBe('Weekly');
    expect(result.rollup.table).toBe('events_weekly');
    expect(result.rollup.buckets).toBe(13);
    expect(result.results.series).toHaveLength(13);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('builds a series from a registered rollup window', () => {
    const result = buildChartSeries('AMP-12345678', VALID_QUERY, MONTHLY_ROLLUP);

    expect(result.status).toBe('complete');
    expect(result.rollup.buckets).toBe(3);
    expect(result.results.total).toBeGreaterThan(0);
    expect(result.chart.metricLabel).toBe('Uniques');
  });

  test('runs hourly retention without raising an incident', async () => {
    const result = await runChartQuery({
      ...VALID_QUERY,
      chartType: 'retention_analysis',
      interval: 'hourly',
    });

    expect(result.rollup.table).toBe('retention_hourly');
    expect(result.rollup.coveredDays).toBe(7);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unsupported lookback range without creating an alert', async () => {
    const { status, body } = await postQuery({ ...VALID_QUERY, interval: 'weekly', lookbackDays: 5000 });

    expect(status).toBe(400);
    expect(body.code).toBe('CHART_RANGE_INVALID');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('keeps monthly rollups for the other chart types', () => {
    expect(resolveRollupWindow('funnel_analysis', 'monthly').table).toBe('funnel_monthly');
    expect(resolveRollupWindow('retention_analysis', 'monthly').table).toBe('retention_monthly');
    expect(resolveRollupWindow('user_sessions', 'monthly').table).toBe('sessions_monthly');
  });
});

describe('Amplitude chart query unregistered rollup window', () => {
  test('has no event segmentation rollup for the monthly interval', () => {
    expect(resolveRollupWindow('event_segmentation', 'monthly')).toBeUndefined();
  });

  test('raises a TypeError and sends the Cognition identity to the alert flow', async () => {
    await expect(runChartQuery(VALID_QUERY)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('5826f4f2');
    expect(alert.service).toBe('customer-5826f4f2-chart-query');
    expect(alert.culprit).toBe('app/services/verticals/5826f4f2.js — buildChartSeries');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/5826f4f2/chart-query' },
      { key: 'chart_type', value: 'event_segmentation' },
      { key: 'interval', value: 'monthly' },
    ]));
  });

  test('returns a 500 response for the default monthly segmentation chart', async () => {
    const { status, body } = await postQuery(VALID_QUERY);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'bucketMs'\)/);
    expect(body.code).toBe('CHART_QUERY_FAILED');
  });
});

describe('Amplitude chart query fixed behavior', () => {
  test('returns a monthly series once the rollup window is registered', async () => {
    ROLLUP_WINDOWS.event_segmentation.monthly = { ...MONTHLY_ROLLUP };

    const result = await runChartQuery(VALID_QUERY);

    expect(result.success).toBe(true);
    expect(result.rollup.table).toBe('events_monthly');
    expect(result.results.series).toHaveLength(3);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns 200 from the API once the rollup window is registered', async () => {
    ROLLUP_WINDOWS.event_segmentation.monthly = { ...MONTHLY_ROLLUP };

    const { status, body } = await postQuery(VALID_QUERY);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.chart.interval).toBe('Monthly');
  });
});

describe('Amplitude chart query validation', () => {
  test('rejects a query with no tracked event without creating an alert', async () => {
    const { status, body } = await postQuery({ ...VALID_QUERY, eventName: 'unknown_event' });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('CHART_INPUTS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a request with no JSON body as a validation error', async () => {
    const { status, body } = await postQuery(undefined);

    expect(status).toBe(400);
    expect(body.code).toBe('CHART_INPUTS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unsupported interval without creating an alert', async () => {
    await expect(runChartQuery({ ...VALID_QUERY, interval: 'yearly' }))
      .rejects.toThrow(/supported chart type and time interval/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

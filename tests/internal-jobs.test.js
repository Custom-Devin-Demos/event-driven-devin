/* global afterEach, beforeEach, describe, expect, jest, test */

const express = require('express');
const http = require('http');
const { setImmediate } = require('timers');

process.env.INTERNAL_JOB_RATE_WINDOW_MS = '60000';
process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = '100';
process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = '100';

const logger = require('../app/telemetry/logger');
const internalJobs = require('../app/routes/internal-jobs');

let requestNumber = 0;

function waitFor(predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for internal job state'));
      } else {
        setImmediate(check);
      }
    }
    check();
  });
}

function request(path, router = internalJobs, forwardedFor = `192.0.2.${++requestNumber}`) {
  const app = express();
  app.use(router);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const headers = { 'X-Forwarded-For': forwardedFor };
      http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        });
      }).on('error', (error) => {
        server.close();
        reject(error);
      });
    });
  });
}

describe('slow-query patrol internal jobs', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test.each([
    ['/internal-jobs/inventory-report', 'inventory.stock_by_sku', 'inventory_report', 120],
    ['/internal-jobs/order-export', 'orders.line_items_scan', 'order_export', 40],
    ['/internal-jobs/reconciliation', 'ledger.full_scan', 'reconciliation', 3],
  ])('%s emits one structured inner-query log per query', async (
    endpoint, queryName, job, queryCount,
  ) => {
    const response = await request(endpoint);
    const queryLogs = infoSpy.mock.calls
      .map(([message, fields]) => ({ message, fields }))
      .filter(({ fields }) => fields && fields.event === 'db.query');
    const summaryLogs = infoSpy.mock.calls
      .map(([, fields]) => fields)
      .filter((fields) => fields && fields.event === 'internal_job.summary');

    expect(response.statusCode).toBe(200);
    expect(queryLogs).toHaveLength(queryCount);
    expect(summaryLogs).toHaveLength(1);
    expect(queryLogs.every(({ message }) => message === 'db.query')).toBe(true);
    expect(queryLogs.every(({ fields }) => fields.query_name === queryName)).toBe(true);
    expect(queryLogs.every(({ fields }) => fields.job === job)).toBe(true);
    expect(queryLogs.every(({ fields }) => fields.endpoint === endpoint)).toBe(true);
    expect(queryLogs.every(({ fields }) => Object.prototype.hasOwnProperty.call(fields, 'duration_ms'))).toBe(true);
    expect(queryLogs.every(({ fields }) => Object.prototype.hasOwnProperty.call(fields, 'rows_scanned'))).toBe(true);
    expect(queryLogs.every(({ fields }) => fields.duration_ms > 0)).toBe(true);
    expect(response.body.totalDurationMs).toBeGreaterThan(0);
    expect(summaryLogs[0].inner_query_count).toBe(queryCount);
  }, 60000);

  test('total-time ranking differs from single-query-duration ranking', async () => {
    const samples = [];
    const dailyRuns = {
      'inventory.stock_by_sku': 720,
      'orders.line_items_scan': 240,
      'ledger.full_scan': 120,
    };
    for (const endpoint of [
      '/internal-jobs/inventory-report',
      '/internal-jobs/order-export',
      '/internal-jobs/reconciliation',
    ]) {
      const response = await request(endpoint);
      expect(response.statusCode).toBe(200);
      const queryLogs = infoSpy.mock.calls
        .map(([, fields]) => fields)
        .filter((fields) => fields && fields.event === 'db.query' && fields.endpoint === endpoint);
      samples.push({
        queryName: queryLogs[0].query_name,
        totalTime: queryLogs.reduce((sum, fields) => sum + fields.duration_ms, 0) * dailyRuns[queryLogs[0].query_name],
        singleQueryDuration: Math.max(...queryLogs.map((fields) => fields.duration_ms)),
      });
    }

    const topByTotalTime = [...samples].sort((a, b) => b.totalTime - a.totalTime)[0].queryName;
    const topBySingleDuration = [...samples]
      .sort((a, b) => b.singleQueryDuration - a.singleQueryDuration)[0].queryName;

    expect(topByTotalTime).toBe('inventory.stock_by_sku');
    expect(topBySingleDuration).toBe('ledger.full_scan');
    expect(topByTotalTime).not.toBe(topBySingleDuration);
  }, 60000);

  test('keeps the single-flight lock until an aborted job completes', async () => {
    const app = express();
    const errors = [];
    app.use(internalJobs);
    app.use((error, _req, _res, _next) => {
      errors.push(error);
    });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const { port } = server.address();
    const firstRequest = http.get(`http://127.0.0.1:${port}/internal-jobs/reconciliation`, {
      headers: { 'X-Forwarded-For': `192.0.2.${++requestNumber}` },
    });
    firstRequest.on('error', () => {});

    try {
      await waitFor(() => infoSpy.mock.calls.some(([, fields]) => fields && fields.event === 'db.query'));
      firstRequest.destroy();
      const secondResponse = await request('/internal-jobs/inventory-report');
      expect(secondResponse.statusCode).toBe(429);
      await waitFor(() => infoSpy.mock.calls.some(([, fields]) => (
        fields && fields.event === 'internal_job.summary' && fields.job === 'reconciliation'
      )));
      expect(errors).toHaveLength(0);
    } finally {
      server.close();
    }
  }, 60000);

  test('releases the lock after a completed job', async () => {
    const firstResponse = await request('/internal-jobs/inventory-report');
    const secondResponse = await request('/internal-jobs/inventory-report');
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
  }, 60000);

  test('treats non-positive rate limits as unlimited', async () => {
    const previousPerIpLimit = process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT;
    const previousProcessLimit = process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT;
    process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = '0';
    process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = '0';
    jest.resetModules();
    const unlimitedJobs = require('../app/routes/internal-jobs');

    try {
      const responses = [];
      for (let requestIndex = 0; requestIndex < 7; requestIndex++) {
        responses.push(await request(
          '/internal-jobs/inventory-report',
          unlimitedJobs,
          '198.51.100.10',
        ));
      }
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    } finally {
      process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = previousPerIpLimit;
      process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = previousProcessLimit;
    }
  }, 60000);

  test('retains the default per-IP rate limit', async () => {
    const previousPerIpLimit = process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT;
    const previousProcessLimit = process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT;
    delete process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT;
    process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = '100';
    jest.resetModules();
    const defaultJobs = require('../app/routes/internal-jobs');

    try {
      const responses = [];
      for (let requestIndex = 0; requestIndex < 5; requestIndex++) {
        responses.push(await request(
          '/internal-jobs/inventory-report',
          defaultJobs,
          '198.51.100.11',
        ));
      }
      expect(responses.slice(0, 4).every((response) => response.statusCode === 200)).toBe(true);
      expect(responses[4].statusCode).toBe(429);
    } finally {
      process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = previousPerIpLimit;
      process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = previousProcessLimit;
    }
  }, 60000);

  test('retains the default process-wide rate limit', async () => {
    const previousPerIpLimit = process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT;
    const previousProcessLimit = process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT;
    process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = '100';
    delete process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT;
    jest.resetModules();
    const defaultJobs = require('../app/routes/internal-jobs');

    try {
      const responses = [];
      for (let requestIndex = 0; requestIndex < 7; requestIndex++) {
        responses.push(await request(
          '/internal-jobs/inventory-report',
          defaultJobs,
          `198.51.100.${20 + requestIndex}`,
        ));
      }
      expect(responses.slice(0, 6).every((response) => response.statusCode === 200)).toBe(true);
      expect(responses[6].statusCode).toBe(429);
    } finally {
      process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = previousPerIpLimit;
      process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = previousProcessLimit;
    }
  }, 60000);
});

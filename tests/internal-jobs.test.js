/* global afterEach, beforeEach, describe, expect, jest, test */

const express = require('express');
const http = require('http');

process.env.INTERNAL_JOB_RATE_WINDOW_MS = '60000';
process.env.INTERNAL_JOB_PER_IP_RATE_LIMIT = '100';
process.env.INTERNAL_JOB_PROCESS_RATE_LIMIT = '100';

const logger = require('../app/telemetry/logger');
const internalJobs = require('../app/routes/internal-jobs');

let requestNumber = 0;

function request(path) {
  const app = express();
  app.use(internalJobs);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const headers = { 'X-Forwarded-For': `192.0.2.${++requestNumber}` };
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
    ['/internal-jobs/reconciliation', 'ledger.full_scan', 'reconciliation', 6],
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
});

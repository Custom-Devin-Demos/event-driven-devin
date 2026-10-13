/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { alertStrings } = require('../app/services/alert-locale');
const customerConfig = require('../config/customers/44169cd7');
const snapshotRoutes = require('../app/routes/verticals/44169cd7');
const {
  SNAPSHOT_RUNS,
  PARTITIONS,
  buildSnapshot,
  feedOverview,
  resetAlertCooldown,
  resolveBusinessDate,
  runSnapshot,
} = require('../app/services/verticals/44169cd7');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'analyst@example.com',
};

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(snapshotRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
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
  createSessionAndAlert.mockClear();
  resetAlertCooldown();
});

describe('Ratings Data Feed overview', () => {
  test('lists both scheduled runs and the latest rating actions', async () => {
    const { status, body } = await request('GET', '/api/44169cd7/feed');
    expect(status).toBe(200);
    expect(body.runs.map((run) => run.runId)).toEqual(['eod-2026-10-12', 'eod-2026-10-09']);
    expect(body.ratingActions.issuers).toHaveLength(8);
    expect(feedOverview().timezone).toBe('America/New_York');
  });
});

describe('Ratings Data Feed snapshot', () => {
  test('delivers the 9 Oct run, whose cut-off falls on the same UTC day', async () => {
    const result = await runSnapshot({ runId: 'eod-2026-10-09', ...IDENTITY });

    expect(result.success).toBe(true);
    expect(result.snapshotId).toMatch(/^RDF-[0-9A-F]{8}$/);
    expect(result.businessDate).toBe('2026-10-09');
    expect(result.issuerCount).toBe(PARTITIONS['2026-10-09'].issuers.length);
    expect(result.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unknown run with a 400 and no alert', async () => {
    const { status, body } = await request('POST', '/api/44169cd7/snapshots', { runId: 'eod-1999-01-01' });

    expect(status).toBe(400);
    expect(body.code).toBe('UNKNOWN_RUN');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Ratings Data Feed 12 Oct end-of-day run', () => {
  const run = SNAPSHOT_RUNS.find((candidate) => candidate.runId === 'eod-2026-10-12');

  test('resolves the business date from the UTC day of a 23:30 ET cut-off', () => {
    expect(resolveBusinessDate(run.cutoffUtc)).toBe('2026-10-13');
    expect(PARTITIONS['2026-10-13']).toBeUndefined();
    expect(() => buildSnapshot(run)).toThrow(TypeError);
  });

  test('raises one alert with the hub identity and no em dashes', async () => {
    await expect(runSnapshot({ runId: run.runId, ...IDENTITY }))
      .rejects.toThrow("Cannot read properties of undefined (reading 'issuers')");
    await expect(runSnapshot({ runId: run.runId, ...IDENTITY })).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('44169cd7');
    expect(alert.service).toBe('ratings-data-feed');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('analyst@example.com');
    expect(alert.slackMemberId).toBeUndefined();
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/44169cd7/snapshots' },
      { key: 'run_id', value: 'eod-2026-10-12' },
    ]));

    const userFacing = [alert.culprit, alert.verticalLabel, alert.promptAppendix, alert.issueTitle].join('\n');
    expect(userFacing).not.toMatch(/\u2014/);
    expect(customerConfig.locale).toBe('en-plain');
    const t = alertStrings('en-plain');
    expect(`${t.header(alert.verticalLabel)}${t.titleSeparator}${alert.issueTitle}`).not.toMatch(/\u2014/);
  });

  test('releases the cooldown when the alert was not delivered', async () => {
    createSessionAndAlert.mockImplementationOnce(() => Promise.resolve(null));
    await expect(runSnapshot({ runId: run.runId, ...IDENTITY })).rejects.toThrow(TypeError);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await expect(runSnapshot({ runId: run.runId, ...IDENTITY })).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('returns a 500 response from the route', async () => {
    const { status, body } = await request('POST', '/api/44169cd7/snapshots', { runId: run.runId, ...IDENTITY });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.code).toBe('SNAPSHOT_FAILED');
    expect(body.snapshotId).toMatch(/^RDF-/);
  });
});

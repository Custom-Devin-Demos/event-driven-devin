/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { Sentry } = require('../app/telemetry/sentry');
const logger = require('../app/telemetry/logger');
const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const {
  generateReport,
  DEMO_PATIENT,
  REPORT_DEADLINE_MS,
} = require('../app/services/oncall-verticals/devicereports');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

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

beforeEach(() => jest.clearAllMocks());

const postReport = (body) => fetch(`${baseUrl}/api/oncall/devicereports/reports`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patientId: DEMO_PATIENT.id, uploadSource: 'clinic-usb', ...body }),
});

describe('e2303f8c MiniMed CareLink on-call skin', () => {
  test('is a native device-reports skin that always alerts to Teams', () => {
    expect(getOncallSkin('e2303f8c')).toMatchObject({
      company: 'MiniMed',
      vertical: 'devicereports',
      oncallOnly: true,
      teamsAlerts: true,
      alertDestination: 'teams',
      page: { file: 'e2303f8c.html', title: 'Upload & reports | MiniMed CareLink' },
    });
    expect(ALERT_SCENARIOS.devicereports).toMatchObject({
      apiPath: '/api/carelink',
      oncallApiPath: '/api/oncall/devicereports',
      alertOnStatus: [504],
      unlisted: true,
    });
  });

  test('skin URL and direct slug serve the same shimmed page', async () => {
    const [skinned, direct] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/e2303f8c`),
      fetch(`${baseUrl}/e2303f8c`),
    ]);
    expect(skinned.status).toBe(200);
    const html = await skinned.text();
    expect(await direct.text()).toEqual(html);
    expect(html).toContain('<title>Upload &amp; reports | MiniMed CareLink</title>');
    expect(html).toContain("fetch('/api/carelink/reports'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/devicereports"');
    expect(html).toContain('const alertOnStatus = [504]');
    expect(html).toContain("uploadSource: document.getElementById('uploadSource').value");
    expect(ALERT_SCENARIOS.devicereports.metricQuery.match(/uploadtype:full/g)).toHaveLength(3);
    expect(html).toContain('var skinAlertDestination = "teams"');
    expect(html).toContain('NOT ACTUALLY A MINIMED SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('stock banking skins keep the scenario trigger (alert on every submit)', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/8df370c5`)).text();
    expect(html).toContain('const triggerWhen = null');
  });

  test('alert card copy stays metric-shaped and free of the company name', () => {
    const card = JSON.stringify(getOncallSkin('e2303f8c').alertCard);
    expect(card).not.toMatch(/MiniMed|Medtronic|TypeError|\.js/);
  });
});

describe('device upload & report on-call vertical', () => {
  test('incremental sync returns the report fast', async () => {
    const started = Date.now();
    const res = await postReport({ uploadType: 'incremental', periodDays: 14 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report).toMatchObject({ uploadType: 'incremental', uploadSource: 'clinic-usb', periodDays: 14 });
    expect(report.summary.timeInRange.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('full 14-day upload times out with 504 and logs each sensor-history fetch', async () => {
    const started = Date.now();
    const res = await postReport({ uploadType: 'full', periodDays: 14 });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ success: false, code: 'REPORT_TIMEOUT', errorClass: 'GatewayTimeout' });
    expect(elapsed).toBeGreaterThanOrEqual(REPORT_DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(REPORT_DEADLINE_MS + 1000);
    const fetchLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Sensor history fetch')
      .map(([, fields]) => fields);
    expect(fetchLogs.length).toBeGreaterThan(10);
    expect(fetchLogs[fetchLogs.length - 1].fetchStatus).toBe('timed_out');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toEqual({
      route: '/api/oncall/devicereports/reports',
      service: 'carelink-reports-api',
    });
  });

  test('rejects unknown patients and periods with 400', async () => {
    await expect(generateReport({ patientId: 'PT-0', uploadType: 'full', uploadSource: 'clinic-usb', periodDays: 14 }))
      .rejects.toMatchObject({ code: 'INVALID_REPORT_REQUEST' });
    expect((await postReport({ uploadType: 'incremental', uploadSource: 'fax', periodDays: 14 })).status).toBe(400);
    const res = await postReport({ uploadType: 'full', periodDays: 3 });
    expect(res.status).toBe(400);
  });
});

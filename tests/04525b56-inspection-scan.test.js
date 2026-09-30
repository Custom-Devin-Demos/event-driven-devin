/* global describe, expect, test, jest, afterEach, setImmediate */

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
const routes = require('../app/routes/verticals/04525b56');
const {
  runInspectionScan,
  APPLICATIONS,
  ZONES,
  SCAN_MODES,
  ZONE_INSPECTION_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/04525b56');

const ORIGINAL_LATENCY = [...ZONE_INSPECTION_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

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
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
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

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  ZONE_INSPECTION_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Camtek wafer inspection scan', () => {
  test('returns the default full-wafer scan in ordered zones with a consistent summary', async () => {
    ZONE_INSPECTION_POLICY.latencyMs = [1, 2];
    LATENCY_SLO.budgetMs = 3000;

    const { status, body } = await request('POST', '/api/04525b56/inspection-scan', {
      application: '',
      scanMode: '',
      waferId: '',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.customer).toBe('Camtek');
    expect(body.waferId).toBe('LOT2471-W07');
    expect(body.application).toEqual({
      key: 'bump-copper-pillar',
      label: 'Bump & Copper Pillar',
      platform: 'Eagle-AP',
    });
    expect(body.scanMode).toEqual({
      key: 'full-wafer',
      label: 'Full-wafer scan (14 zones)',
      zoneCount: 14,
    });
    expect(body.recipe).toBe('Eagle-AP-bump-copper-pillar-R4.2');
    expect(body.zones.map((zone) => zone.zone)).toEqual(ZONES);
    expect(body.zones).toHaveLength(14);
    expect(body.durationMs).toBeLessThan(LATENCY_SLO.budgetMs);
    expect(Number.isNaN(Date.parse(body.inspectedAt))).toBe(false);

    const defectClasses = ['particle', 'scratch', 'bumpHeight', 'bridging', 'residue'];
    const expectedSummary = {
      diesInspected: body.zones.reduce((sum, zone) => sum + zone.diesInspected, 0),
      defectsFound: body.zones.reduce((sum, zone) => sum + zone.defects, 0),
      killerDefects: body.zones.reduce((sum, zone) => sum + zone.killerDefects, 0),
      knownGoodDies: body.zones.reduce((sum, zone) => sum + zone.knownGoodDies, 0),
      defectClasses: Object.fromEntries(defectClasses.map((className) => [
        className,
        body.zones.reduce((sum, zone) => sum + zone.defectClasses[className], 0),
      ])),
      worstZone: body.zones.reduce((worst, zone) => (
        !worst || zone.killerDefects > worst.killerDefects ? zone : worst
      ), null).zone,
    };
    expectedSummary.yieldPct = Math.round(
      (expectedSummary.knownGoodDies / expectedSummary.diesInspected) * 1000,
    ) / 10;
    expect(body.summary).toEqual(expectedSummary);
    expect(Object.values(body.summary.defectClasses).reduce((sum, count) => sum + count, 0))
      .toBe(body.summary.defectsFound);
    expect(body.summary.knownGoodDies)
      .toBe(body.summary.diesInspected - body.summary.killerDefects);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('returns the same zone inspection data for the same application, wafer, and mode', async () => {
    ZONE_INSPECTION_POLICY.latencyMs = [1, 2];

    const first = await runInspectionScan({ waferId: 'lot2471-w07' });
    const second = await runInspectionScan({ waferId: 'LOT2471-W07' });

    expect(first.waferId).toBe('LOT2471-W07');
    expect(second.waferId).toBe(first.waferId);
    expect(second.zones).toEqual(first.zones);
    expect(second.summary).toEqual(first.summary);
  });

  test.each([
    ['center-zone', ['C1']],
    ['edge-ring', ['EDGE']],
  ])('%s scans only its configured zone', async (scanMode, expectedZones) => {
    ZONE_INSPECTION_POLICY.latencyMs = [1, 2];

    const { status, body } = await request('POST', '/api/04525b56/inspection-scan', { scanMode });

    expect(status).toBe(200);
    expect(body.scanMode.key).toBe(scanMode);
    expect(body.scanMode.zoneCount).toBe(1);
    expect(body.zones.map((zone) => zone.zone)).toEqual(expectedZones);
  });

  test.each([
    [{ application: 'unknown-app' }, 'INVALID_APPLICATION'],
    [{ scanMode: 'unknown-mode' }, 'INVALID_SCAN_MODE'],
    [{ waferId: 'W-1' }, 'INVALID_WAFER_ID'],
  ])('rejects invalid scan input %p', async (body, code) => {
    const { status, body: response } = await request(
      'POST',
      '/api/04525b56/inspection-scan',
      body,
    );

    expect(status).toBe(400);
    expect(response.success).toBe(false);
    expect(response.errorClass).toBe('ValidationError');
    expect(response.code).toBe(code);
    expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reports a successful full-wafer response and schedules a latency alert on breach', async () => {
    ZONE_INSPECTION_POLICY.latencyMs = [1, 2];
    LATENCY_SLO.budgetMs = 0;

    const { status, body } = await request('POST', '/api/04525b56/inspection-scan', {
      application: 'cmos-image-sensor',
      scanMode: 'center-zone',
      waferId: ' lot2471-w08 ',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.waferId).toBe('LOT2471-W08');
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe(
      `LatencyBudgetExceeded: POST /api/04525b56/inspection-scan took ${body.durationMs}ms (budget 0ms)`,
    );
    expect(alert.customer).toBe('04525b56');
    expect(alert.service).toBe('customer-04525b56-inspection-scan');
    expect(alert.culprit).toBe('reportLatencyBreach(app/services/verticals/04525b56)');
    expect(alert.verticalLabel).toBe('Camtek Wafer Inspection Scan');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/04525b56/inspection-scan' },
      { key: 'service', value: 'customer-04525b56-inspection-scan' },
      { key: 'application', value: 'cmos-image-sensor' },
      { key: 'scanMode', value: 'center-zone' },
      { key: 'zoneCount', value: '1' },
      { key: 'durationMs', value: String(body.durationMs) },
    ]));
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'LatencyBudgetExceeded',
        message: `POST /api/04525b56/inspection-scan took ${body.durationMs}ms (budget 0ms)`,
      }),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          route: '/api/04525b56/inspection-scan',
          service: 'customer-04525b56-inspection-scan',
          alert_path: 'latency',
          application: 'cmos-image-sensor',
          scanMode: 'center-zone',
          zoneCount: '1',
        }),
      }),
    );
  });

  test('does not create an alert when the scan is within budget', async () => {
    ZONE_INSPECTION_POLICY.latencyMs = [1, 2];
    LATENCY_SLO.budgetMs = 3000;

    const result = await runInspectionScan({ scanMode: 'center-zone' });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('returns applications, scan modes, zones, defaults, and latency budget metadata', async () => {
    const { status, body } = await request('GET', '/api/04525b56/applications');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.applications).toEqual(Object.entries(APPLICATIONS).map(([key, application]) => ({
      key,
      label: application.label,
      platform: application.platform,
      diesPerZone: application.diesPerZone,
    })));
    expect(body.scanModes).toEqual(Object.entries(SCAN_MODES).map(([key, scanMode]) => ({
      key,
      label: scanMode.label,
      zoneCount: scanMode.zones.length,
      default: scanMode.default,
    })));
    expect(body.zones).toEqual(ZONES);
    expect(body.defaults).toEqual({
      application: 'bump-copper-pillar',
      scanMode: 'full-wafer',
      waferId: 'LOT2471-W07',
    });
    expect(body.latencyBudgetMs).toBe(3000);
  });
});

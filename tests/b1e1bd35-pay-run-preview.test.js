/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/b1e1bd35');
const {
  previewPayRun,
  payCalendar,
  COUNTRIES,
  SCOPE_OPTIONS,
  PROVIDER_POLL_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/b1e1bd35');

const ORIGINAL_LATENCY = [...PROVIDER_POLL_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const VALID = { companyName: 'Meridian Global Holdings', email: 'payroll@meridiangh.com' };

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
      const req = http.request({
        host: '127.0.0.1', port, path, method, headers,
      }, (res) => {
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

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  PROVIDER_POLL_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('CloudPay multi-country pay-run preview', () => {
  test('default scope polls every CloudPay country in directory order', async () => {
    PROVIDER_POLL_POLICY.latencyMs = [1, 3];

    const result = await previewPayRun(VALID);

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^CP-[0-9A-F]{8}$/);
    expect(result.scope).toEqual({ key: 'all', label: 'All CloudPay countries (14 in-country providers)' });
    expect(result.countriesPolled).toBe(COUNTRIES.length);
    expect(result.countries.map((c) => c.countryCode)).toEqual(COUNTRIES.map((c) => c.code));
    expect(result.payRunId).toMatch(/^PR-\d{6}-\d{4}$/);
    expect(result.payRunId.slice(3, 9)).toBe(result.payPeriod.key.replace('-', ''));
    result.countries.forEach((preview) => {
      expect(preview.netLocal).toBeLessThan(preview.grossLocal);
      expect(preview.grossUsd).toBe(Math.round(preview.grossLocal * preview.usdPerUnit * 100) / 100);
      expect(preview.netUsd).toBe(Math.round(preview.netLocal * preview.usdPerUnit * 100) / 100);
      expect(['Ready for approval', 'Awaiting inputs']).toContain(preview.status);
      expect(preview.payDate).toBe(result.payDate);
      expect(preview.inputCutoff).toBe(result.inputCutoff);
    });
    expect(result.totals.headcount).toBe(result.countries.reduce((sum, c) => sum + c.headcount, 0));
    expect(Math.abs(result.totals.grossUsd - result.countries.reduce((sum, c) => sum + c.grossUsd, 0))).toBeLessThan(0.011);
    expect(Math.abs(result.totals.netUsd - result.countries.reduce((sum, c) => sum + c.netUsd, 0))).toBeLessThan(0.011);
  });

  test.each([
    ['2026-10-08T12:00:00Z', '2026-10', 'October 2026', '2026-10-30', '2026-10-23', '2026-10-08'],
    ['2026-05-04T12:00:00Z', '2026-05', 'May 2026', '2026-05-29', '2026-05-22', '2026-05-04'],
    ['2026-02-11T12:00:00Z', '2026-02', 'February 2026', '2026-02-27', '2026-02-20', '2026-02-11'],
    // On the cut-off day itself the current month is still in play.
    ['2026-10-23T12:00:00Z', '2026-10', 'October 2026', '2026-10-30', '2026-10-23', '2026-10-23'],
    // Past the cut-off, the period rolls to the next month (Dec -> Jan across the year boundary).
    ['2026-10-26T12:00:00Z', '2026-11', 'November 2026', '2026-11-30', '2026-11-23', '2026-10-26'],
    ['2026-12-28T12:00:00Z', '2027-01', 'January 2027', '2027-01-29', '2027-01-22', '2026-12-28'],
  ])('pay calendar for %s', (now, key, label, payDate, inputCutoff, ratesAsOf) => {
    const calendar = payCalendar(new Date(now));

    expect(calendar.payPeriod).toEqual({ key, label });
    expect(calendar.payDate).toBe(payDate);
    expect(calendar.inputCutoff).toBe(inputCutoff);
    expect(calendar.ratesAsOf).toBe(ratesAsOf);
    expect(new Date(`${calendar.payDate}T00:00:00Z`).getUTCDay()).toBeLessThan(6);
    expect(calendar.inputCutoff >= calendar.ratesAsOf).toBe(true);
  });

  test('previews are deterministic for the same company', async () => {
    PROVIDER_POLL_POLICY.latencyMs = [1, 2];
    const first = await previewPayRun(VALID);
    const second = await previewPayRun(VALID);
    expect(second.countries).toEqual(first.countries);
    expect(second.payRunId).toBe(first.payRunId);
  });

  test.each(['gb', 'us', 'sg'])('single-country scope %p polls one provider quickly', async (scope) => {
    const started = Date.now();
    const result = await previewPayRun({ ...VALID, scope });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.countriesPolled).toBe(1);
    expect(result.countries.map((c) => c.countryCode)).toEqual(SCOPE_OPTIONS[scope].countries);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...VALID, companyName: ' ' }, 'COMPANY_NAME_INVALID'],
    [{ ...VALID, email: 'not-an-email' }, 'EMAIL_INVALID'],
    [{ ...VALID, scope: 'everywhere' }, 'SCOPE_INVALID'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const response = await request('POST', '/api/b1e1bd35/pay-run-preview', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, errorClass: 'ValidationError', code });
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body).toHaveProperty('requestId');
  });

  test('POST route returns the pay-run preview payload', async () => {
    PROVIDER_POLL_POLICY.latencyMs = [1, 2];
    const response = await request('POST', '/api/b1e1bd35/pay-run-preview', { ...VALID, scope: 'gb' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.countries[0].country).toBe('United Kingdom');
    expect(response.body.payPeriod.key).toMatch(/^\d{4}-\d{2}$/);
  });

  test('GET countries lists the directory and scope options', async () => {
    const response = await request('GET', '/api/b1e1bd35/countries');

    expect(response.status).toBe(200);
    expect(response.body.countries).toHaveLength(COUNTRIES.length);
    expect(response.body.countries[0]).toEqual({
      code: 'GB', country: 'United Kingdom', flag: '🇬🇧', currency: 'GBP', provider: 'CloudPay UK Payroll Bureau',
    });
    expect(response.body.scopeOptions.find((o) => o.key === 'all').countryCount).toBe(COUNTRIES.length);
  });

  test('a latency budget breach triggers the Devin alert', async () => {
    PROVIDER_POLL_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const result = await previewPayRun({
      ...VALID, devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: '',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.errorType).toBe('LatencyBudgetExceeded');
    expect(payload.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/b1e1bd35\/pay-run-preview took \d+ms \(budget 1ms\)$/);
    expect(payload.culprit).toBe('app/services/verticals/b1e1bd35.js — pollInCountryProviders');
    expect(payload.customer).toBe('b1e1bd35');
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.promptAppendix).toContain('pollInCountryProviders');
    expect(payload.extra.countriesPolled).toBe(COUNTRIES.length);
  });
});

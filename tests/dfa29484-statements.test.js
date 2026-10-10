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
const routes = require('../app/routes/verticals/dfa29484');
const { VEHICLES, PERIODS, FUND_ADMIN_FEED } = require('../app/services/verticals/dfa29484');

const COMMINGLED = ['OCDL-IV', 'GPSC-V', 'NLRE-II'];
const CO_INVEST = 'ORTI-CI';
const IDENTITY = {
  devinUserId: 'okta|Cognition|00u23apa1taDNwWlr1d8',
  devinOrgId: 'org_69IXJFLrljx8zSAw',
  devinEmail: 'julia.rhee@cognition.ai',
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const raw = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(raw.toString('utf8')); } catch (_) { /* binary */ }
          resolve({ status: res.statusCode, headers: res.headers, raw, body: json });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('Blue Owl Investor Portal (dfa29484) — capital account statements', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('GET /api/dfa29484/capital-account returns the LP, four vehicles and the periods', async () => {
    const res = await request(makeApp(), 'GET', '/api/dfa29484/capital-account');
    expect(res.status).toBe(200);
    expect(res.body.investor.name).toMatch(/Meridian State Teachers/);
    expect(res.body.vehicles).toHaveLength(4);
    expect(res.body.periods.map((p) => p.id)).toEqual(PERIODS.map((p) => p.id));
    expect(res.body.totals.commitment).toBe(VEHICLES.reduce((a, v) => a + v.commitment, 0));
  });

  test('commingled vehicles render for every offered period, CSV is downloadable', async () => {
    const app = makeApp();
    for (const period of PERIODS) {
      const res = await request(app, 'POST', '/api/dfa29484/statements', {
        periodId: period.id, vehicleIds: COMMINGLED, format: 'csv', ...IDENTITY,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.rows).toHaveLength(3);
      expect(res.body.rows.map((r) => r.feeBasis)).toEqual(['invested_capital', 'committed_capital', 'nav']);

      const dl = await request(app, 'GET', res.body.statement.downloadUrl);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toMatch(/text\/csv/);
      expect(dl.raw.toString('utf8').split('\n')[0]).toMatch(/^vehicleId,vehicleName,/);
      expect(dl.raw.toString('utf8')).toContain('"OCDL-IV"');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('quarterly allocations reconcile: each quarter closes at the next quarter\'s opening balance', () => {
    const ordered = [...PERIODS].reverse().map((p) => p.id);
    for (const vehicle of VEHICLES) {
      for (let i = 0; i < ordered.length; i += 1) {
        const rec = FUND_ADMIN_FEED[ordered[i]][vehicle.id];
        const fees = (rec.managementFee ? rec.managementFee.accrued : 0) + (rec.carriedInterest ? rec.carriedInterest.accrued : 0);
        const rollForward = rec.beginningBalance + rec.contributions - rec.distributions + rec.netInvestmentIncome + rec.realizedGain + rec.unrealizedGain - fees;
        expect(Math.round(rollForward * 100) / 100).toBe(rec.endingBalance);
        if (i + 1 < ordered.length) expect(rec.endingBalance).toBe(FUND_ADMIN_FEED[ordered[i + 1]][vehicle.id].beginningBalance);
      }
      expect(Object.keys(FUND_ADMIN_FEED['2026Q1'][vehicle.id]).includes('managementFee')).toBe(vehicle.id !== CO_INVEST);
    }
  });

  test('statement IDs never collide with archived statements and every download URL resolves', async () => {
    const app = makeApp();
    const seen = new Set();
    for (let i = 0; i < 16; i += 1) {
      const res = await request(app, 'POST', '/api/dfa29484/statements', { periodId: '2026Q2', vehicleIds: ['OCDL-IV'], format: 'csv' });
      expect(res.status).toBe(200);
      expect(seen.has(res.body.statement.id)).toBe(false);
      seen.add(res.body.statement.id);
      const dl = await request(app, 'GET', res.body.statement.downloadUrl);
      expect(dl.status).toBe(200);
    }
  }, 30000);

  test('PDF statements return a downloadable PDF document', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/api/dfa29484/statements', {
      periodId: '2026Q3', vehicleIds: COMMINGLED, format: 'pdf', ...IDENTITY,
    });
    expect(res.status).toBe(200);
    expect(res.body.statement.format).toBe('pdf');
    expect(res.body.statement.pages).toBe(4);
    const dl = await request(app, 'GET', res.body.statement.downloadUrl);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.raw.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(dl.raw.toString('latin1')).toContain('/Count 4');
    expect(dl.raw.toString('latin1')).toMatch(/%%EOF\s*$/);
  });

  test('fee-free co-invest sleeve fails with a TypeError after the commingled rows render, and alerts as Julia', async () => {
    const res = await request(makeApp(), 'POST', '/api/dfa29484/statements', {
      periodId: '2026Q3', vehicleIds: [...COMMINGLED, CO_INVEST], format: 'pdf', ...IDENTITY,
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      errorClass: 'TypeError',
      code: 'STATEMENT_RENDER_FAILED',
      vehicleId: CO_INVEST,
    });
    expect(res.body.error).toMatch(/toLowerCase/);
    expect(res.body.requestId).toMatch(/^req_/);
    expect(res.body.rows).toHaveLength(3);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: 'dfa29484',
      errorType: 'TypeError',
      slackMemberId: process.env.BLUEOWL_SLACK_MEMBER_ID || 'U0B7F46NVA4',
      ...IDENTITY,
    });
    expect(alert.culprit).toContain('normalizeFeeBasis');
  });

  test('rejects requests with no vehicles and unknown formats with structured 400s', async () => {
    const app = makeApp();
    const none = await request(app, 'POST', '/api/dfa29484/statements', { periodId: '2026Q3', vehicleIds: [], format: 'csv' });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ success: false, code: 'NO_VEHICLES_SELECTED' });

    const fmt = await request(app, 'POST', '/api/dfa29484/statements', { periodId: '2026Q3', vehicleIds: COMMINGLED, format: 'docx' });
    expect(fmt.status).toBe(400);
    expect(fmt.body.success).toBe(false);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a second concurrent generate for the same period is refused with 409 STATEMENT_IN_PROGRESS', async () => {
    const app = makeApp();
    const body = { periodId: '2026Q2', vehicleIds: COMMINGLED, format: 'csv' };
    const [first, second] = await Promise.all([
      request(app, 'POST', '/api/dfa29484/statements', body),
      new Promise((resolve) => setTimeout(() => resolve(request(app, 'POST', '/api/dfa29484/statements', body)), 50)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('STATEMENT_IN_PROGRESS');
  });

  test('unknown statement download is a structured 404', async () => {
    const res = await request(makeApp(), 'GET', '/api/dfa29484/statements/STMT-NOPE/download');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'STATEMENT_NOT_FOUND' });
  });
});

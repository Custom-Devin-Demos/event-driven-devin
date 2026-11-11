/* global jest, afterAll, beforeAll, describe, expect, test, fetch */
const express = require('express');
const { processTransfer } = require('../app/services/oncall-verticals/banking');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const routes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(routes);
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(() => stopGateway().then(() => done())); });

const post = (path, body, headers = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('failAfterHang skins', () => {
  test('a transfer that outlives the hold fails with HOLD_EXPIRED; without a hold it succeeds', async () => {
    const data = { fromAccount: 'ACCT-1001', toAccount: 'ACCT-1002', amount: 50, accountTier: 'premium', userId: 'usr_hold' };
    await expect(processTransfer(data, { holdTtlMs: 1 })).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    await expect(processTransfer(data)).resolves.toMatchObject({ success: true });
  });

  test('telco: the failAfterHang skin hangs, then gets a calm 504', async () => {
    expect(getOncallSkin('b77d601c')).toMatchObject({ vertical: 'telco', failAfterHang: true });
    const started = Date.now();
    const res = await post('/api/oncall/telco/upgrade', {
      accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'PLUS-24', billingDay: 15,
    }, { 'X-Oncall-Skin': 'b77d601c' });
    const body = await res.json();
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThan(5000);
    expect(body).toMatchObject({ success: false, code: 'HOLD_EXPIRED' });
    expect(body.error).toMatch(/try again in a few minutes/);
    expect(body.error).not.toMatch(/hold|ms\b/i);
  });

  test('banking: failAfterMs ends the hang with a 504 after ~5s', async () => {
    expect(getOncallSkin('10aff157')).toMatchObject({ vertical: 'banking', failAfterHang: true, failAfterMs: 5000 });
    const started = Date.now();
    const res = await post('/api/oncall/banking/transfer', {
      fromAccount: 'ACCT-1001', toAccount: 'ACCT-1002', amount: 50, accountTier: 'standard',
    }, { 'X-Oncall-Skin': '10aff157' });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe('HOLD_EXPIRED');
    expect(elapsed).toBeGreaterThan(5000);
    expect(elapsed).toBeLessThan(6500);
  });

  test('hightech: the failAfterHang skin hangs, then gets a calm 504', async () => {
    const res = await post('/api/oncall/licenses/provision', {
      orgName: 'enterprise_suite', planName: 'enterprise', seats: 25, billingCycle: 'annual',
    }, { 'X-Oncall-Skin': '9f836bf5' });
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe('HOLD_EXPIRED');
  });

  test('a skin without failAfterHang still succeeds after the hang', async () => {
    const rogers = getOncallSkin('42a72d14');
    expect(rogers).toMatchObject({ vertical: 'telco' });
    expect(rogers.failAfterHang).toBeUndefined();
    const res = await post('/api/oncall/telco/upgrade', {
      accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'PLUS-24', billingDay: 15,
    }, { 'X-Oncall-Skin': '42a72d14' });
    expect(res.status).toBe(200);
  });

  test('the alert card is a 5xx rate only for failAfterHang skins', () => {
    for (const v of ['banking', 'telco', 'hightech']) {
      expect(ALERT_SCENARIOS[v].failAfterHangCard.monitor).toMatch(/^5xx rate — /);
      expect(ALERT_SCENARIOS[v].monitor).toMatch(/latency/);
    }
  });
});

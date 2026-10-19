const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { submitCardPayment } = require('../app/services/oncall-verticals/cardpayment');
const { getOncallSkin } = require('../config/oncall-skins');

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
  server.close(done);
});

function pay(body) {
  return fetch(`${baseUrl}/api/oncall/cardpayment/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('accounts dashboard on-call skin (8f167941)', () => {
  test('is a native card-payment skin with its own page', () => {
    const skin = getOncallSkin('8f167941');
    expect(skin).toMatchObject({ vertical: 'cardpayment', oncallOnly: true, page: { file: '8f167941.html' } });
    expect(ALERT_SCENARIOS.cardpayment).toMatchObject({
      apiPath: '/api/8f167941/card-payment',
      oncallApiPath: '/api/oncall/cardpayment/payment',
      triggerWhen: { fromAccount: 'CHK-1634' },
      unlisted: true,
    });
  });

  test('skin URL, direct slug and friendly path serve the same shimmed page', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/oncall/c/8f167941`),
      fetch(`${baseUrl}/8f167941`),
      fetch(`${baseUrl}/bofa-oncall`),
    ]);
    responses.forEach((r) => expect(r.status).toBe(200));
    const [skinned, direct, friendly] = await Promise.all(responses.map((r) => r.text()));
    expect(direct).toEqual(skinned);
    expect(friendly).toEqual(skinned);
    expect(skinned).toContain('<title>Accounts Overview | Bank of America</title>');
    expect(skinned).toContain('const oncallApiPath = "/api/oncall/cardpayment/payment"');
    expect(skinned).toContain('const triggerWhen = {"fromAccount":"CHK-1634"}');
    expect(skinned).toContain("fetch('/api/8f167941/card-payment'");
    expect(skinned).toContain('<option value="CHK-1634" data-label="My Checking" data-balance="4000.00">');
    expect(skinned).toContain('v <= availableBalance()');
    expect(skinned).toContain('NOT ACTUALLY A BANK OF AMERICA SITE');
  });

  test('paying from checking fails with a 500', async () => {
    const response = await pay({ fromAccount: 'CHK-1634', toAccount: 'CARD-4417', amount: 25 });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'We could not process your payment.',
      errorClass: 'TypeError',
      code: 'PAYMENT_FAILED',
    });
  });

  test('paying from savings succeeds with a fee-free receipt', async () => {
    const response = await pay({ fromAccount: 'SAV-8820', toAccount: 'CARD-4417', amount: 412.37 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      fromAccount: { id: 'SAV-8820', label: 'My Savings' },
      amount: '412.37',
      fee: '0.00',
      totalDebit: '412.37',
      rail: 'book-transfer',
    });
    expect(body.confirmationNumber).toMatch(/^BA[0-9A-F]{8}$/);
  });

  test('rejects fractional cents, unknown accounts and overdrafts', async () => {
    const [cents, unknown, overdraft] = await Promise.all([
      pay({ fromAccount: 'SAV-8820', amount: 1.001 }),
      pay({ fromAccount: 'ACCT-1002', amount: 25 }),
      pay({ fromAccount: 'SAV-8820', amount: 9000 }),
    ]);
    expect([cents.status, unknown.status, overdraft.status]).toEqual([400, 400, 422]);
    expect((await overdraft.json()).code).toBe('INSUFFICIENT_FUNDS');
  });

  test('savings payments after the cutoff post the next business day', async () => {
    const result = await submitCardPayment(
      { fromAccount: 'SAV-8820', toAccount: 'CARD-4417', amount: 25 },
      new Date('2026-10-20T02:00:00Z'),
    );
    expect(result.postsOn).toBe('next_business_day');
  });

  test('weekend payments post the next business day', async () => {
    const saturdayMorning = new Date('2026-10-24T14:00:00Z');
    const result = await submitCardPayment({ fromAccount: 'SAV-8820', toAccount: 'CARD-4417', amount: 25 }, saturdayMorning);
    expect(result.postsOn).toBe('next_business_day');
  });

  test('error monitor query is an error percentage of all payment requests', () => {
    expect(ALERT_SCENARIOS.cardpayment.metricQuery).toMatch(/errors\{[^}]+\}\.as_count\(\) \/ sum:trace\.express\.request\.hits\{[^}]+\}\.as_count\(\) \* 100$/);
  });
});

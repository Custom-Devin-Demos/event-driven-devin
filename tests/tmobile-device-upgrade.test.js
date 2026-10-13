jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');

const DEMO_TOKEN = 'tmobile-presenter-demo';

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { checkoutUpgrade, alerting, REMEDIATION_DIRECTIVE } = require('../app/services/verticals/tmobile');
const tmobileRouter = require('../app/routes/verticals/tmobile');

const DEMO_ORDER = {
  accountNumber: '958204417',
  lineNumber: '(312) 555-0187',
  deviceSku: 'iphone-17-pro-256-orange',
  tradeIn: true,
};

const checkoutFailing = () => checkoutUpgrade({ ...DEMO_ORDER, demoToken: DEMO_TOKEN }).catch(() => {});

describe('T-Mobile device upgrade checkout service (tmobile)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    alerting.enabled = true;
  });

  test('rejects an incomplete request with a 400 ValidationError and no alert', async () => {
    await expect(checkoutUpgrade({ deviceSku: 'nope', lineNumber: '1' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a line in a fully registered market places an order on EIP', async () => {
    const result = await checkoutUpgrade({
      accountNumber: '471993025',
      lineNumber: '214-555-0110',
      deviceSku: 'iphone-17-pro-256-orange',
      tradeIn: true,
    });
    expect(result.status).toBe('submitted');
    expect(result.orderNumber).toMatch(/^TM[0-9A-F]{9}$/);
    expect(result.months).toBe(24);
    expect(result.monthlyPayment).toBe(45.83);
    expect(result.monthlyCredit).toBe(34.58);
    expect(result.monthlyAfterCredits).toBe(11.25);
    expect(result.eipLedgerShard).toBe('eip-ledger-02');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the demo line fails every time with EipLedgerUnavailable', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(checkoutUpgrade(DEMO_ORDER)).rejects.toMatchObject({
        name: 'EipLedgerUnavailable',
        code: 'EIP_LEDGER_UNAVAILABLE',
        statusCode: 500,
        message: expect.stringContaining('shard eip-ledger-usc-midwest for market USC-MW is not registered'),
      });
    }
  });

  test('an upgrade without the presenter token fails without alerting', async () => {
    await expect(checkoutUpgrade(DEMO_ORDER)).rejects.toMatchObject({ name: 'EipLedgerUnavailable' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the ledger outage is not reported to Sentry, which would double-alert', async () => {
    await expect(checkoutUpgrade({ ...DEMO_ORDER, demoToken: DEMO_TOKEN }))
      .rejects.toMatchObject({ name: 'EipLedgerUnavailable' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the alert goes to the owner email on a macOS session, ignoring caller identity', async () => {
    await expect(checkoutUpgrade({
      ...DEMO_ORDER,
      demoToken: DEMO_TOKEN,
      devinOrgId: 'org-attacker',
      devinUserId: 'user-attacker',
      devinEmail: 'attacker@example.com',
    })).rejects.toMatchObject({ name: 'EipLedgerUnavailable' });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      devinOrgId: undefined,
      devinUserId: undefined,
      devinEmail: 'yubin.jee@cognition.ai',
      customer: 'tmobile',
      sessionPlatform: 'macos',
      promptAppendix: REMEDIATION_DIRECTIVE,
    }));
  });

  test('every presenter checkout alerts, with no throttling', async () => {
    await checkoutFailing();
    await checkoutFailing();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('the kill switch silences alerting entirely', async () => {
    alerting.enabled = false;
    await expect(checkoutUpgrade({ ...DEMO_ORDER, demoToken: DEMO_TOKEN }))
      .rejects.toMatchObject({ name: 'EipLedgerUnavailable' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('an ineligible line and unknown account are rejected without alerting', async () => {
    await expect(checkoutUpgrade({ ...DEMO_ORDER, lineNumber: '3125550142', demoToken: DEMO_TOKEN }))
      .rejects.toMatchObject({ name: 'UpgradeNotEligible', statusCode: 409 });
    await expect(checkoutUpgrade({ ...DEMO_ORDER, accountNumber: '111', demoToken: DEMO_TOKEN }))
      .rejects.toMatchObject({ name: 'AccountNotFound', statusCode: 404 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the directive keeps the fix in the iOS client and off the deployed host', () => {
    expect(REMEDIATION_DIRECTIVE).toContain('COG-GTM/ios-demos');
    expect(REMEDIATION_DIRECTIVE).toContain('do NOT change the backend');
    expect(REMEDIATION_DIRECTIVE).toContain('never set `TMOBILE_DEMO_TOKEN`');
    expect(REMEDIATION_DIRECTIVE).not.toContain('devindemos.com');
  });
});

describe('POST /api/tmobile/upgrade/checkout', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.requestId = 'req-test'; next(); });
    app.use(tmobileRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => createSessionAndAlert.mockClear());

  const post = (headers = {}) => fetch(`${baseUrl}/api/tmobile/upgrade/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(DEMO_ORDER),
  });

  test('returns the planted failure as JSON with the real status', async () => {
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'EipLedgerUnavailable',
      message: expect.stringContaining('Equipment installment ledger is unavailable'),
      code: 'EIP_LEDGER_UNAVAILABLE',
      requestId: 'req-test',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alerts only when the presenter token header is present', async () => {
    await post({ 'X-TMobile-Demo-Token': DEMO_TOKEN });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });
});

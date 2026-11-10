/* global describe, expect, test, jest, beforeEach, beforeAll, afterAll */
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'member-1', email: 'someone@cognition.ai' },
    { user_id: 'wes-user-1', email: 'Wes.Convery@cognition.ai' },
  ])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../app/services/slack', () => ({
  postMessage: jest.fn(() => Promise.resolve('1730000000.000100')),
  findChannelByName: jest.fn(() => Promise.resolve({ id: 'C0FEEDBACK1', name: 'dell-com-feedback' })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { postMessage, findChannelByName } = require('../app/services/slack');
const { listOrgUsers } = require('../app/services/devin-api');
const { selectedAlertDestination } = require('../app/services/alert-destination');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { Sentry } = require('../app/telemetry/sentry');
const service = require('../app/services/verticals/683629b3');
const router = require('../app/routes/verticals/683629b3');
const { getCustomerConfig, listAliases } = require('../config/customers');

const {
  CUSTOMER, API_BASE, ROUTE, FEEDBACK_ROUTE, APP_WEB_PATH, CHECKOUT_ERROR, ONCALL_CHANNEL, FEEDBACK_CHANNEL,
  PRODUCTS, MEMORY_OPTIONS, STORAGE_OPTIONS, FULFILLMENT_LANES, REMEDIATION_DIRECTIVE, OWNER,
} = service;

const APP_DIR = path.join(__dirname, '..', 'app', 'public', 'verticals', `${CUSTOMER}-app`);
const SECRET_PATTERN = /\.js|FULFILLMENT_LANES|cto-na|leadDays|reserveFulfillment|at Object/;

let server;
let baseUrl;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${urlPath}`,
      { method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const json = (res.headers['content-type'] || '').includes('json');
          resolve({ status: res.statusCode, body: json ? JSON.parse(data) : data, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const cartItem = (overrides = {}) => ({
  productId: 'dell-14-plus', memory: 16, storage: 512, color: 'Ice Blue', quantity: 1, ...overrides,
});

function everyConfiguration() {
  const configs = [];
  for (const product of PRODUCTS) {
    for (const memory of MEMORY_OPTIONS) {
      for (const storage of STORAGE_OPTIONS) {
        for (const color of product.colors) {
          configs.push({ productId: product.id, memory: memory.value, storage: storage.value, color, quantity: 1 });
        }
      }
    }
  }
  return configs;
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = 'req-test'; next(); });
  app.use(router);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  createSessionAndAlert.mockImplementation(() => Promise.resolve({ triggered: true }));
  process.env.DEVIN_ORG_ID = 'org_test';
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env[FEEDBACK_CHANNEL.envVar];
  service.resetIncidentWindow();
  service.resetFeedbackState();
});

describe('683629b3 Dell.com storefront — registration and hosting', () => {
  test('is an unlisted api-mode customer routed to #dell-oncall', () => {
    const config = getCustomerConfig(CUSTOMER);
    expect(config).toMatchObject({ customer: CUSTOMER, label: 'Dell.com storefront', triggerMode: 'api', slackChannelId: ONCALL_CHANNEL.id });
    expect(ONCALL_CHANNEL).toEqual({ id: 'C0CAX4SHG6M', name: '#dell-oncall' });
    expect(Object.values(listAliases())).not.toContain(CUSTOMER);
    expect(OWNER).toEqual({ slackMemberId: 'U0AS6QZDFD0', email: 'wes.convery@cognition.ai' });
  });

  test('the hosted build exists and is built for the app path', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    expect(html).toContain(`src="${APP_WEB_PATH}/assets/`);
    expect(html).not.toContain('src="/src/main.tsx"');
    const js = fs.readdirSync(path.join(APP_DIR, 'assets')).filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    const bundle = fs.readFileSync(path.join(APP_DIR, 'assets', js[0]), 'utf8');
    expect(bundle).toContain(API_BASE);
    expect(bundle).not.toContain('"/api/orders"');
    for (const image of PRODUCTS.map((p) => p.image)) {
      expect(fs.existsSync(path.join(APP_DIR, image))).toBe(true);
    }
  });

  test('app path, SPA routes and friendly aliases all reach the build', async () => {
    const index = await request('GET', `${APP_WEB_PATH}/`);
    expect(index.status).toBe(200);
    expect(index.body).toContain('<div id="root">');
    for (const deep of ['/laptops', '/products/dell-14-plus', '/cart', '/account/orders/DEMO-10482']) {
      const res = await request('GET', `${APP_WEB_PATH}${deep}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(index.body);
    }
    for (const alias of [`/${CUSTOMER}`, '/dell-com', '/dellcom', '/dell-store', '/dell-storefront']) {
      const res = await request('GET', alias);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${APP_WEB_PATH}/`);
    }
  });

  test('catalog, account, config and health answer with no-store', async () => {
    const [catalog, account, config, health, missing] = await Promise.all([
      request('GET', `${API_BASE}/catalog`),
      request('GET', `${API_BASE}/account`),
      request('GET', `${API_BASE}/config`),
      request('GET', `${API_BASE}/health`),
      request('GET', `${API_BASE}/nothing-here`),
    ]);
    expect(catalog.status).toBe(200);
    expect(catalog.headers['cache-control']).toBe('no-store');
    expect(catalog.body.products.map((p) => p.id)).toEqual(['dell-14-plus', 'dell-15', 'dell-16', 'xps-13']);
    expect(account.body.profile.fullName).toBe('Alex Morgan');
    expect(account.body.orders.map((o) => o.id)).toEqual(['DEMO-10482', 'DEMO-10463']);
    expect(config.body).toMatchObject({ scenario: 'checkout-unavailable', channel: '#dell-oncall', feedbackChannel: '#dell-com-feedback', feedbackMode: 'dry-run' });
    expect(health.body).toEqual({ ok: true, service: `customer-${CUSTOMER}-web` });
    expect(missing.status).toBe(404);
  });
});

describe('683629b3 Dell.com storefront — pricing and account', () => {
  test('quotes a configuration and a cart with 8% tax and free shipping', async () => {
    const quote = await request('POST', `${API_BASE}/quotes`, cartItem({ memory: 32, storage: 1024, quantity: 2 }));
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ productId: 'dell-14-plus', unitPriceCents: 99999, totalCents: 199998 });
    const cart = await request('POST', `${API_BASE}/cart/quote`, { items: [cartItem(), cartItem({ productId: 'xps-13', color: 'Graphite' })] });
    expect(cart.status).toBe(200);
    expect(cart.body).toMatchObject({ subtotalCents: 194998, shippingCents: 0, taxCents: 15600, totalCents: 210598 });
  });

  test('rejects invalid configurations with 400 and never pages on-call', async () => {
    const bad = await Promise.all([
      request('POST', `${API_BASE}/quotes`, cartItem({ color: 'Neon' })),
      request('POST', `${API_BASE}/quotes`, cartItem({ memory: 64 })),
      request('POST', `${API_BASE}/quotes`, cartItem({ quantity: 11 })),
      request('POST', `${API_BASE}/cart/quote`, { items: [] }),
      request('POST', ROUTE, { items: [cartItem({ productId: 'alienware' })] }),
      request('POST', ROUTE, {}),
    ]);
    bad.forEach((res) => {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CART');
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('order status refresh stays healthy for sample orders and 404s otherwise', async () => {
    const ok = await request('POST', `${API_BASE}/account/orders/DEMO-10482/status`, {});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'DEMO-10482', status: 'In Production', demo: true });
    expect(typeof ok.body.refreshedAt).toBe('string');
    const missing = await request('POST', `${API_BASE}/account/orders/DEMO-1/status`, {});
    expect(missing.status).toBe(404);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('683629b3 Dell.com storefront — Place order on-call trigger', () => {
  test('Place order fails for every catalog configuration with the exact storefront error after the hold', async () => {
    const configs = everyConfiguration();
    expect(configs.length).toBe(36);
    for (const item of configs) {
      const started = Date.now();
      let caught;
      try {
        await service.placeOrder({ items: [item] }, { hold: 20 });
      } catch (error) {
        caught = error;
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
      expect(caught).toBeDefined();
      expect(caught.name).toBe('TypeError');
      expect(caught).toMatchObject({ statusCode: 503, code: 'CHECKOUT_UNAVAILABLE', publicMessage: CHECKOUT_ERROR });
    }
  });

  test('the route answers 503 "unable to process your order" after ~500ms without leaking internals', async () => {
    const started = Date.now();
    const res = await request('POST', ROUTE, { items: [cartItem(), cartItem({ productId: 'dell-16', color: 'Carbon Black', memory: 32 })] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: CHECKOUT_ERROR, code: 'CHECKOUT_UNAVAILABLE', errorClass: 'TypeError' });
    expect(res.body.requestId).toMatch(/^DCO-[0-9A-F]{8}$/);
    expect(JSON.stringify(res.body)).not.toMatch(SECRET_PATTERN);
  });

  test('the failure is captured and raised as a #dell-oncall alert + Devin session for the demo owner', async () => {
    let caught;
    try {
      await service.placeOrder({ items: [cartItem()] }, { hold: 0 });
    } catch (error) {
      caught = error;
    }
    await caught.sessionPromise;
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ route: ROUTE, service: `customer-${CUSTOMER}-web`, alert_path: 'instant' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: CUSTOMER,
      service: `customer-${CUSTOMER}-web`,
      verticalLabel: 'Dell.com storefront',
      errorType: 'TypeError',
      devinUserId: 'wes-user-1',
      devinEmail: OWNER.email,
      devinOrgId: 'org_test',
      slackMemberIdFallback: OWNER.slackMemberId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      level: 'error',
    });
    expect(listOrgUsers).toHaveBeenCalledWith('org_test', expect.any(Object));
    expect(getCustomerConfig(alert.customer).slackChannelId).toBe(ONCALL_CHANNEL.id);
    // The Sentry issue webhook for this culprit must not raise a second alert.
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, culprit: alert.culprit, tags: [] })).toBe(true);
    expect(REMEDIATION_DIRECTIVE).toContain('COG-GTM/event-driven-devin');
    expect(REMEDIATION_DIRECTIVE).toContain(`tests/${CUSTOMER}-storefront.test.js`);
    expect(REMEDIATION_DIRECTIVE).not.toMatch(/cto-na|leadDays/);
  });

  test('the alert is always routed to Slack even when the browser picked Teams', async () => {
    createSessionAndAlert.mockImplementation(() => Promise.resolve({ triggered: true, destination: selectedAlertDestination() }));
    let caught;
    try {
      await service.placeOrder({ items: [cartItem()] }, { hold: 0 });
    } catch (error) {
      caught = error;
    }
    const result = await caught.sessionPromise;
    expect(result.destination).toBe('slack');
  });

  test('an undelivered alert reopens the window so the next checkout pages again', async () => {
    createSessionAndAlert.mockImplementationOnce(() => Promise.resolve(null));
    createSessionAndAlert.mockImplementationOnce(() => Promise.reject(new Error('slack down')));
    for (let i = 0; i < 3; i += 1) {
      let caught;
      try {
        await service.placeOrder({ items: [cartItem()] }, { hold: 0 });
      } catch (error) {
        caught = error;
      }
      await caught.sessionPromise;
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(3);
  });

  test('repeat failures within the incident window join the open incident instead of paging again', async () => {
    for (let i = 0; i < 3; i += 1) {
      let caught;
      try {
        await service.placeOrder({ items: [cartItem()] }, { hold: 0 });
      } catch (error) {
        caught = error;
      }
      await caught.sessionPromise;
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('a cart checks out once the fulfillment lane resolves (the fix Devin ships)', async () => {
    FULFILLMENT_LANES['cto-na-v2'] = { ...FULFILLMENT_LANES['cto-na'] };
    try {
      const res = await request('POST', ROUTE, { items: [cartItem({ quantity: 2 }), cartItem({ productId: 'xps-13', color: 'Graphite' })] });
      expect(res.status).toBe(201);
      expect(res.body.orderId).toMatch(/^DEMO-[0-9A-F]{8}$/);
      expect(res.body).toMatchObject({ demo: true, subtotalCents: 269997, totalCents: 291597 });
      expect(res.body.fulfillment).toHaveLength(2);
      expect(res.body.fulfillment[0]).toMatchObject({ productId: 'dell-14-plus', estimatedDays: 7 });
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    } finally {
      delete FULFILLMENT_LANES['cto-na-v2'];
    }
  });
});

describe('683629b3 Dell.com storefront — Contact Us bug report', () => {
  const report = { title: 'Place order fails', description: 'Clicking Place order shows an error after a short spinner.', page: '/cart' };

  test('validates the report before anything leaves the server', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const bad = await Promise.all([
      request('POST', FEEDBACK_ROUTE, { ...report, title: 'ab' }),
      request('POST', FEEDBACK_ROUTE, { ...report, description: 'too short' }),
      request('POST', FEEDBACK_ROUTE, { ...report, page: 'https://evil.example/' }),
      request('POST', FEEDBACK_ROUTE, { ...report, page: '/cart?token=abc' }),
      request('POST', FEEDBACK_ROUTE, {}),
    ]);
    bad.forEach((res) => {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FEEDBACK_REJECTED');
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(findChannelByName).not.toHaveBeenCalled();
  });

  test('without a bot token the report is a dry run and the UI is told so', async () => {
    const res = await request('POST', FEEDBACK_ROUTE, report);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'dry-run', channel: '#dell-com-feedback' });
    expect(postMessage).not.toHaveBeenCalled();
    const config = await request('GET', `${API_BASE}/config`);
    expect(config.body.feedbackMode).toBe('dry-run');
  });

  test('live reports resolve #dell-com-feedback once and post plain-text blocks there — never #dell-oncall', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const first = await request('POST', FEEDBACK_ROUTE, report);
    const second = await request('POST', FEEDBACK_ROUTE, { ...report, title: 'Second <b>report</b> *markup*' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ status: 'sent', channel: '#dell-com-feedback' });
    expect(second.status).toBe(201);
    expect(findChannelByName).toHaveBeenCalledTimes(1);
    expect(findChannelByName).toHaveBeenCalledWith('xoxb-test', 'dell-com-feedback');
    expect(postMessage).toHaveBeenCalledTimes(2);
    const [token, channel, text, blocks] = postMessage.mock.calls[1];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe('C0FEEDBACK1');
    expect(channel).not.toBe(ONCALL_CHANNEL.id);
    expect(text).toBe('Dell.com demo \u2014 new bug report');
    expect(text).not.toContain('<');
    expect(blocks.every((block) => (block.text ? block.text.type === 'plain_text' : block.elements.every((e) => e.type === 'plain_text')))).toBe(true);
    expect(blocks[1].text.text).toBe('Second <b>report</b> *markup*');
    const channelPing = await request('POST', FEEDBACK_ROUTE, { ...report, title: '<!channel> everyone look' });
    expect(channelPing.status).toBe(201);
    expect(postMessage.mock.calls[2][2]).not.toContain('<!channel>');
    expect(postMessage.mock.calls[2][3][1].text).toEqual({ type: 'plain_text', text: '<!channel> everyone look' });
    expect(blocks[3].elements[0].text).toContain('Page: /cart');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    const config = await request('GET', `${API_BASE}/config`);
    expect(config.body.feedbackMode).toBe('live');
  });

  test('a configured channel id is used as-is but the on-call channel is refused', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env[FEEDBACK_CHANNEL.envVar] = 'C0CONFIGURED';
    const ok = await request('POST', FEEDBACK_ROUTE, report);
    expect(ok.status).toBe(201);
    expect(postMessage.mock.calls[0][1]).toBe('C0CONFIGURED');
    expect(findChannelByName).not.toHaveBeenCalled();

    process.env[FEEDBACK_CHANNEL.envVar] = ONCALL_CHANNEL.id;
    const refused = await request('POST', FEEDBACK_ROUTE, report);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toContain('#dell-com-feedback');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test('an unresolvable channel or a Slack failure is reported honestly and not retried', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    findChannelByName.mockResolvedValueOnce(null);
    const unresolved = await request('POST', FEEDBACK_ROUTE, report);
    expect(unresolved.status).toBe(503);
    expect(unresolved.body.error).toBe('Bug reporting is not connected to #dell-com-feedback on this server.');
    expect(postMessage).not.toHaveBeenCalled();

    postMessage.mockRejectedValueOnce(new Error('Slack API error: channel_not_found'));
    const failed = await request('POST', FEEDBACK_ROUTE, report);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('Unable to confirm delivery. Check #dell-com-feedback before retrying.');
    expect(failed.body.error).not.toContain('channel_not_found');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test('limits bug reports to five per minute per process', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await request('POST', FEEDBACK_ROUTE, report));
    expect(results.slice(0, 5).every((res) => res.status === 201)).toBe(true);
    expect(results[5].status).toBe(429);
    expect(postMessage).toHaveBeenCalledTimes(5);
  });
});

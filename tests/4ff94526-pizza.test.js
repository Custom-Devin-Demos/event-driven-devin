jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { buildAlertBlocks } = require('../app/services/slack');
const svc = require('../app/services/verticals/4ff94526');
const router = require('../app/routes/verticals/4ff94526');
const { getCustomerConfig, listAliases } = require('../config/customers');

const pizza = (overrides = {}) => ({
  quantity: 1, crust: 'HANDTOSS', size: 'large', seasoning: 'garlic-crust-seasoning',
  sauce: 'robust-inspired-tomato-sauce', saucePortion: 'normal', cheese: 'cheese', cheesePortion: 'normal',
  meats: [], veggies: [], extraCheese: [], dips: [], instructions: '', ...overrides,
});
beforeEach(() => jest.clearAllMocks());

describe("Domino's builder registration and original assets", () => {
  test('registers an ID slug and friendly alias without operator impersonation', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: "Domino's — Build Your Own Pizza", triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases().dominos).toBe('4ff94526');
    const config = require('../config/customers/4ff94526');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
    const js = fs.readFileSync(path.join(__dirname, '../app/public/verticals/4ff94526-assets/builder.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`identity('${key}')`);
    expect(js).toContain("fetch('/api/4ff94526/cart'");
    expect(js).not.toMatch(/clerk-user_|org-[a-f0-9]{32}/);
  });

  test('all 45 builder options and locally served original fonts/images exist', () => {
    expect(svc.CATALOG.flatMap(g => g.options)).toHaveLength(45);
    for (const group of svc.CATALOG) {
      for (const option of group.options) {
        if (option.image) expect(fs.statSync(path.join(__dirname, '../app/public', option.image)).size).toBeGreaterThan(20);
      }
    }
    for (const asset of ['hero.webp', 'domino.webp', 'logo.svg', 'Dominos_Sans_Text_VF.woff2', 'Dominos_Sans_Display_VF.woff2']) {
      expect(fs.statSync(path.join(__dirname, '../app/public/verticals/4ff94526-assets', asset)).size).toBeGreaterThan(100);
    }
  });
});

describe('server-authoritative pricing and validation', () => {
  test.each([
    ['HANDTOSS', 'small', 9.99], ['HANDTOSS', 'medium', 11.99], ['HANDTOSS', 'large', 13.99],
    ['NPAN', 'medium', 13.99], ['THIN', 'medium', 11.99], ['THIN', 'large', 13.99],
    ['BK', 'medium', 11.99], ['BK', 'large', 13.99], ['GLUTENF', 'small', 11.99],
  ])('%s / %s is healthy with total %s', async (crust, size, total) => {
    await expect(svc.addToCart({ pizza: pizza({ crust, size }) })).resolves.toMatchObject({ success: true, total, currency: 'USD' });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('charges toppings, extra cheese, dips and quantity; ignores client prices', async () => {
    const result = await svc.addToCart({ pizza: pizza({ quantity: 2, meats: ['pepperoni'], veggies: ['mushrooms'], extraCheese: ['feta-cheese'], cheesePortion: 'extra', dips: ['garlic-dipping-cup'], total: 0, unitPrice: 0 }) });
    expect(result).toMatchObject({ unitPrice: 20.98, total: 41.96 });
    expect(result.pizza.total).toBeUndefined(); expect(result.cartItemId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('no cheese does not charge for an unused extra-cheese portion', async () => {
    await expect(svc.addToCart({ pizza: pizza({ cheese: 'no-cheese', cheesePortion: 'extra', sauce: 'no-sauce' }) })).resolves.toMatchObject({ total: 13.99 });
  });

  test.each([
    null, [], {}, pizza({ quantity: 0 }), pizza({ quantity: -1 }), pizza({ quantity: 1.5 }), pizza({ quantity: 11 }), pizza({ quantity: '1' }),
    pizza({ crust: 'unknown' }), pizza({ crust: '__proto__' }), pizza({ size: 'unknown' }), pizza({ crust: 'PSC', size: 'small' }),
    pizza({ crust: 'GLUTENF', size: 'large' }), pizza({ crust: 'NPAN', size: 'large' }),
    pizza({ seasoning: null }), pizza({ sauce: 'unknown' }), pizza({ cheese: 'unknown' }),
    pizza({ meats: ['pepperoni', 'pepperoni'] }), pizza({ meats: ['unknown'] }), pizza({ veggies: 'onions' }), pizza({ dips: null }),
    pizza({ saucePortion: 'giant' }), pizza({ cheesePortion: '' }), pizza({ instructions: 42 }), pizza({ instructions: 'a'.repeat(201) }),
  ])('rejects invalid options before alerting: %j', async input => {
    await expect(svc.addToCart({ pizza: input })).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'INVALID_PIZZA' });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('planted crust pricing failure and incident flow', () => {
  test('PSC produces one Sentry capture and instant alert with actionable PR prompt', async () => {
    await expect(svc.addToCart({ pizza: pizza({ crust: 'PSC' }), devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'surcharge')", status: 500, code: 'PIZZA_CART_FAILED',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({ tags: expect.objectContaining({ customer: svc.CUSTOMER, alert_path: 'instant' }) }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: svc.CUSTOMER, service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { crust: 'PSC', size: 'large', quantity: 1 } });
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(isInstantPathEvent({ culprit: svc.CULPRIT, tags: [] })).toBe(true);
    expect(buildPrompt(alert)).toContain('4ff94526');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('pull request against main; do not merge or deploy');
    expect(alert.promptAppendix).toContain('$3 per pizza');
    const blocks = JSON.stringify(buildAlertBlocks(alert));
    expect(blocks).toContain("Domino's"); expect(blocks).toContain('surcharge');
  });

  test('alert delivery failures never replace the original pricing error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.addToCart({ pizza: pizza({ crust: 'PSC' }) })).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith("Failed to create Devin session for Domino's pizza builder", expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
  let server, port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  test('catalog includes crust size availability, not the internal pricing map', async () => {
    const res = await request('GET', '/api/4ff94526/catalog');
    expect(res.status).toBe(200); expect(res.body.groups).toHaveLength(8);
    expect(res.body.crustSizes.PSC).toEqual(['large']); expect(JSON.stringify(res.body)).not.toContain('PARMESAN_STUFFED');
  });
  test('cart returns 500 on planted bug, 200 on healthy requests, 400 on invalid input', async () => {
    expect(await request('POST', '/api/4ff94526/cart', { pizza: pizza({ crust: 'PSC' }), devinUserId: 'route-user', devinOrgId: 'route-org' })).toMatchObject({ status: 500, body: { success: false, code: 'PIZZA_CART_FAILED', errorClass: 'TypeError' } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    expect(await request('POST', '/api/4ff94526/cart', { pizza: pizza() })).toMatchObject({ status: 200, body: { success: true, total: 13.99 } });
    expect(await request('POST', '/api/4ff94526/cart', { pizza: pizza({ quantity: 0 }) })).toMatchObject({ status: 400, body: { code: 'INVALID_PIZZA' } });
    expect(await request('POST', '/api/4ff94526/cart')).toMatchObject({ status: 400 });
  });
});

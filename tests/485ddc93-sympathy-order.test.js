/* global describe, expect, test, jest, beforeEach, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
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
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  buildStorefront,
  placeOrder,
  PRODUCTS,
  CATEGORIES,
} = require('../app/services/verticals/485ddc93');
const routes = require('../app/routes/verticals/485ddc93');
const { getCustomerConfig } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'user-abc123',
  devinOrgId: 'org-xyz789',
  devinEmail: 'antonio@devindemos.com',
};

function request(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = {};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: url,
        method,
        headers,
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const response = {
            status: res.statusCode,
            body: contentType.includes('application/json') ? JSON.parse(responseBody) : responseBody,
            contentType,
          };
          server.close(() => resolve(response));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Tribute Technology sympathy store', () => {
  test('storefront contains the product catalog, categories, and current obituary events', () => {
    const storefront = buildStorefront();
    const today = new Date();
    const expectedDeath = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3))
      .toISOString().slice(0, 10);

    expect(storefront.products).toHaveLength(25);
    expect(storefront.categories).toHaveLength(5);
    expect(storefront.categories.map(({ slug, name }) => [slug, name])).toEqual([
      ['funeral-flowers', 'Funeral Flowers'],
      ['sympathy-arrangements', 'Sympathy Flowers'],
      ['plants', 'Plants'],
      ['memorial-trees', 'Memorial Trees'],
      ['gift-baskets', 'Sympathy Gift Baskets'],
    ]);
    expect(storefront.products).toEqual(PRODUCTS);
    expect(storefront.categories).toEqual(CATEGORIES);
    expect(storefront.obituary).toMatchObject({
      obId: 40210017,
      fullName: 'Margaret Ellen Hayes',
      dateOfDeath: expectedDeath,
    });
    expect(storefront.events[0]).toMatchObject({
      eventType: 'visitation',
      title: 'Visitation',
      startTime: '16:00',
    });
    expect(storefront.events).toHaveLength(3);
  });

  test('default funeral-home order throws a TypeError and alerts the clicking user', async () => {
    await expect(placeOrder({
      product: 'eternal-grace-standing-spray',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      ...IDENTITY,
    })).rejects.toThrow("Cannot read properties of undefined (reading 'date')");

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ alert_path: 'instant' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('485ddc93');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('scheduleFuneralHomeDelivery');
    expect(alert.devinUserId).toBe(IDENTITY.devinUserId);
    expect(alert.devinOrgId).toBe(IDENTITY.devinOrgId);
    expect(alert.devinEmail).toBe(IDENTITY.devinEmail);
    expect(alert.promptAppendix).toContain('app/services/verticals/485ddc93.js');
  });

  test('residence orders succeed with correct pricing and non-Sunday delivery dates', async () => {
    const basket = await placeOrder({
      product: 'fruit-and-flowers-basket',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      recipientName: 'Thomas Hayes',
      recipientAddress: '17 Garden Lane, Millbrook, CT 06478',
    });
    expect(basket).toMatchObject({
      success: true,
      subtotal: 79.99,
      deliveryFee: 14.99,
      tax: 6.65,
      total: 101.63,
      destination: { key: 'residence' },
    });

    const arrangement = await placeOrder({
      product: 'tender-heart-arrangement',
      size: 'deluxe',
      destination: 'residence',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      recipientName: 'Thomas Hayes',
      recipientAddress: '17 Garden Lane, Millbrook, CT 06478',
    });
    expect(arrangement.size).toMatchObject({ code: 'deluxe', price: 89.99 });
    expect(arrangement.destination.key).toBe('residence');

    [basket, arrangement].forEach((order) => {
      expect(order.delivery.date >= todayUtc()).toBe(true);
      expect(new Date(`${order.delivery.date}T00:00:00Z`).getUTCDay()).not.toBe(0);
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('residence orders return card text and use same-day or next-day delivery as appropriate', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-14T15:00:00Z'),
      doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick', 'queueMicrotask'],
    });

    const basket = await placeOrder({
      product: 'fruit-and-flowers-basket',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      recipientName: 'Thomas Hayes',
      recipientAddress: '17 Garden Lane, Millbrook, CT 06478',
      cardMessage: '  Thinking of you, Sam.  ',
      cardSignature: '  The Price family  ',
    });
    expect(basket.delivery).toMatchObject({
      date: '2026-10-14',
      window: '13:00–17:00',
      windowLabel: 'Same-day afternoon (1:00 PM – 5:00 PM)',
    });
    expect(basket.card).toEqual({
      message: 'Thinking of you, Sam.',
      signature: 'The Price family',
    });

    const orchid = await placeOrder({
      product: 'orchid-elegance',
      destination: 'residence',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      recipientName: 'Thomas Hayes',
      recipientAddress: '17 Garden Lane, Millbrook, CT 06478',
    });
    expect(orchid.delivery.date).toBe('2026-10-15');
  });

  test('same-day residence orders move to Monday when today is Sunday', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-18T15:00:00Z'),
      doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick', 'queueMicrotask'],
    });

    const basket = await placeOrder({
      product: 'fruit-and-flowers-basket',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
      recipientName: 'Thomas Hayes',
      recipientAddress: '17 Garden Lane, Millbrook, CT 06478',
    });
    expect(basket.delivery.date).toBe('2026-10-19');
  });

  test.each([
    [{ product: 'missing-product', senderName: 'Ann Lee', senderEmail: 'ann@example.com' }, 'PRODUCT_INVALID'],
    [{ product: 'eternal-grace-standing-spray', size: 'giant', senderName: 'Ann Lee', senderEmail: 'ann@example.com' }, 'PRODUCT_INVALID'],
    [{ product: 'fruit-and-flowers-basket', destination: 'funeral_home', senderName: 'Ann Lee', senderEmail: 'ann@example.com' }, 'DESTINATION_INVALID'],
    [{ product: 'eternal-grace-standing-spray', destination: 'residence', senderName: 'Ann Lee', senderEmail: 'ann@example.com', recipientName: 'Thomas Hayes', recipientAddress: '17 Garden Lane' }, 'DESTINATION_INVALID'],
    [{ product: 'fruit-and-flowers-basket', senderName: 'A', senderEmail: 'ann@example.com', recipientName: 'Thomas Hayes', recipientAddress: '17 Garden Lane' }, 'SENDER_INVALID'],
    [{ product: 'fruit-and-flowers-basket', senderName: 'Ann Lee', senderEmail: 'invalid', recipientName: 'Thomas Hayes', recipientAddress: '17 Garden Lane' }, 'SENDER_INVALID'],
    [{ product: 'fruit-and-flowers-basket', senderName: 'Ann Lee', senderEmail: 'ann@example.com' }, 'RECIPIENT_INVALID'],
    [{ product: 'fruit-and-flowers-basket', senderName: 'Ann Lee', senderEmail: 'ann@example.com', recipientName: 'Thomas Hayes', recipientAddress: '17 Garden Lane', cardMessage: 'x'.repeat(201) }, 'CARD_MESSAGE_INVALID'],
    [{ product: 'fruit-and-flowers-basket', senderName: 'Ann Lee', senderEmail: 'ann@example.com', recipientName: 'Thomas Hayes', recipientAddress: '17 Garden Lane', cardSignature: 'x'.repeat(101) }, 'CARD_MESSAGE_INVALID'],
  ])('validation errors do not alert (%#)', async (data, code) => {
    await expect(placeOrder(data)).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code,
      requestId: expect.stringMatching(/^TS-[0-9A-F]{8}$/),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('customer config and instant-path webhook behavior identify the Tribute alert', () => {
    expect(getCustomerConfig('485ddc93').label).toMatch(/Tribute/);
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/485ddc93.js — scheduleFuneralHomeDelivery',
    })).toBe(true);
  });
});

describe('Tribute Technology sympathy store routes', () => {
  test('/tributetech alias and storefront data are served', async () => {
    const { aliases } = require('../app/routes/verticals');
    expect(aliases.tributetech).toBe('485ddc93');

    const storefront = await request('GET', '/api/485ddc93/storefront');
    expect(storefront.status).toBe(200);
    expect(storefront.body.products).toHaveLength(25);
  });

  test('POST /api/485ddc93/orders returns 500 for the default order and 400 for invalid input', async () => {
    const failed = await request('POST', '/api/485ddc93/orders', {
      product: 'eternal-grace-standing-spray',
      senderName: 'Ann Lee',
      senderEmail: 'ann@example.com',
    });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ errorClass: 'TypeError', code: 'ORDER_FAILED' });

    const invalid = await request('POST', '/api/485ddc93/orders', {
      product: 'eternal-grace-standing-spray',
      senderEmail: 'ann@example.com',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      success: false,
      code: 'SENDER_INVALID',
      requestId: expect.stringMatching(/^TS-[0-9A-F]{8}$/),
    });
  });
});

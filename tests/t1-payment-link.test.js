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
  createPaymentLink,
  MERCHANT,
  PAYMENT_METHODS,
  RECENT_LINKS,
  CLABE_PROVIDERS,
  ValidationError,
  clabeCheckDigit,
} = require('../app/services/verticals/t1');
const t1Routes = require('../app/routes/verticals/t1');
const t1Customer = require('../config/customers/t1');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const SEED_RECENT_LINKS = RECENT_LINKS.map((link) => ({ ...link }));

const VALID_LINK = {
  amount: 1250,
  concept: 'Mensualidad Yoga Flow',
  methods: { card: true, spei: true },
};

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(t1Routes);

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
        path,
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

beforeEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

afterEach(() => {
  RECENT_LINKS.splice(0, RECENT_LINKS.length, ...SEED_RECENT_LINKS.map((link) => ({ ...link })));
});

describe('T1 Pagos payment links', () => {
  test('SPEI link creation fails on the migrated provider code and raises an alert', async () => {
    await expect(createPaymentLink(VALID_LINK)).rejects.toThrow(
      "Cannot read properties of undefined (reading 'clabePrefix')",
    );

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('t1');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('createPaymentLink');
    expect(alert.promptAppendix).toContain('/t1');
  });

  test('card-only link creation succeeds without an SPEI field or alert', async () => {
    const result = await createPaymentLink({
      ...VALID_LINK,
      concept: '  Mensualidad Yoga Flow  ',
      methods: { card: true, msi: false, spei: false },
    });

    expect(result.success).toBe(true);
    expect(result.link.url).toMatch(/^https:\/\/payments\.t1\.com\/l\/T1L-[A-Z0-9]{5}$/);
    expect(result.link).not.toHaveProperty('spei');
    expect(result.link.methods).toEqual([PAYMENT_METHODS.card.label]);
    expect(RECENT_LINKS[0]).toMatchObject({
      code: result.link.code,
      concept: 'Mensualidad Yoga Flow',
      amount: 1250,
      currency: 'MXN',
      status: 'activo',
      createdAt: result.createdAt,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('caps the recent-link list at ten entries', async () => {
    RECENT_LINKS.splice(0, RECENT_LINKS.length, ...Array.from({ length: 10 }, (_, index) => ({
      ...SEED_RECENT_LINKS[0],
      code: `T1L-${index}`,
    })));

    const result = await createPaymentLink({
      ...VALID_LINK,
      methods: { card: true, msi: false, spei: false },
    });

    expect(RECENT_LINKS).toHaveLength(10);
    expect(RECENT_LINKS[0].code).toBe(result.link.code);
  });

  test('MSI card links include all installment terms', async () => {
    const result = await createPaymentLink({
      ...VALID_LINK,
      amount: 1200,
      methods: { card: true, msi: true, spei: false },
    });

    expect(result.link.installments).toHaveLength(4);
    expect(result.link.installments[0]).toEqual({ months: 3, monthly: '400.00' });
  });

  test.each([
    ['empty concept', { ...VALID_LINK, concept: '  ' }, 'Ingresa el concepto de pago.'],
    ['non-finite amount', { ...VALID_LINK, amount: Infinity }, 'Ingresa un monto válido.'],
    ['non-positive amount', { ...VALID_LINK, amount: 0 }, 'Ingresa un monto válido.'],
    [
      'no selected payment methods',
      { ...VALID_LINK, methods: { card: false, spei: false } },
      'Selecciona al menos un método de pago.',
    ],
    [
      'card amount below its limit',
      { ...VALID_LINK, amount: 0.5, methods: { card: true, spei: false } },
      'El monto debe estar entre $1.00 y $250,000.00 MXN para tarjeta.',
    ],
    [
      'card amount above its limit',
      { ...VALID_LINK, amount: 250001, methods: { card: true, spei: false } },
      'El monto debe estar entre $1.00 y $250,000.00 MXN para tarjeta.',
    ],
    [
      'SPEI amount below its limit',
      { ...VALID_LINK, amount: 5, methods: { card: false, spei: true } },
      'El monto debe estar entre $10.00 y $99,999.00 MXN para transferencia.',
    ],
    [
      'SPEI amount above its limit',
      { ...VALID_LINK, amount: 100000, methods: { card: false, spei: true } },
      'El monto debe estar entre $10.00 y $99,999.00 MXN para transferencia.',
    ],
    [
      'MSI without card acceptance',
      { ...VALID_LINK, methods: { card: false, msi: true, spei: true } },
      'Los pagos a MSI requieren aceptar tarjetas.',
    ],
    [
      'MSI below the minimum amount',
      { ...VALID_LINK, amount: 250, methods: { card: true, msi: true, spei: false } },
      'Los pagos a MSI requieren un monto mínimo de $300.00 MXN.',
    ],
  ])('rejects %s before telemetry alerts', async (_label, input, message) => {
    await expect(createPaymentLink(input)).rejects.toThrow(ValidationError);
    await expect(createPaymentLink(input)).rejects.toThrow(message);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('passes demo identity through without assigning a hard-coded Slack member', async () => {
    await expect(createPaymentLink({
      ...VALID_LINK,
      devinEmail: 'arturo@devindemos.com',
      devinUserId: 'clerk-user_t1',
      devinOrgId: 'org_t1',
    })).rejects.toThrow(TypeError);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.devinEmail).toBe('arturo@devindemos.com');
    expect(alert.devinUserId).toBe('clerk-user_t1');
    expect(alert.devinOrgId).toBe('org_t1');
    expect(alert.slackMemberId).toBeUndefined();
  });

  test('calculates a valid CLABE check digit', () => {
    expect(clabeCheckDigit('00201007777777777')).toBe('1');
    expect(`${'00201007777777777'}${clabeCheckDigit('00201007777777777')}`).toBe('002010077777777771');
    expect(() => clabeCheckDigit('123')).toThrow(TypeError);
  });

  test('creates an SPEI CLABE when its provider is registered', async () => {
    const existingProvider = CLABE_PROVIDERS.stp_v2;
    CLABE_PROVIDERS.stp_v2 = CLABE_PROVIDERS.stp;

    try {
      const result = await createPaymentLink({
        ...VALID_LINK,
        methods: { card: false, msi: false, spei: true },
      });

      expect(result.link.spei.clabe).toHaveLength(18);
      expect(result.link.spei.clabe.endsWith(clabeCheckDigit(result.link.spei.clabe.slice(0, 17)))).toBe(true);
      expect(result.link.spei.bank).toBe('STP');
      expect(result.link.spei.reference).toBeTruthy();
    } finally {
      if (existingProvider === undefined) {
        delete CLABE_PROVIDERS.stp_v2;
      } else {
        CLABE_PROVIDERS.stp_v2 = existingProvider;
      }
    }
  });

  test('rethrows unexpected validation input errors without alerting', async () => {
    await expect(createPaymentLink(null)).rejects.toThrow(TypeError);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('logs alert-pipeline failures without replacing the payment-link error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('Alert unavailable'));
    await expect(createPaymentLink(VALID_LINK)).rejects.toThrow(
      "Cannot read properties of undefined (reading 'clabePrefix')",
    );
    await Promise.resolve();
  });

  test('merchant endpoint returns the payment-link dashboard data', async () => {
    const response = await request('GET', '/api/t1/merchant');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      merchant: MERCHANT,
      paymentMethods: PAYMENT_METHODS,
      recentLinks: RECENT_LINKS,
    });
  });

  test('serves the T1 page', async () => {
    const response = await request('GET', '/t1');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
  });

  test('payment-link route returns successful card-only links', async () => {
    const response = await request('POST', '/api/t1/payment-links', {
      ...VALID_LINK,
      methods: { card: true, msi: false, spei: false },
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.link.url).toMatch(/^https:\/\/payments\.t1\.com\/l\/T1L-[A-Z0-9]{5}$/);
    expect(response.body.link).not.toHaveProperty('spei');

    const dashboard = await request('GET', '/api/t1/merchant');
    expect(dashboard.body.recentLinks[0].code).toBe(response.body.link.code);
  });

  test('payment-link route maps service errors and validation to their API responses', async () => {
    const failure = await request('POST', '/api/t1/payment-links', VALID_LINK);
    expect(failure.status).toBe(500);
    expect(failure.body).toMatchObject({
      success: false,
      errorClass: 'TypeError',
      code: 'PAYMENT_LINK_CREATION_FAILED',
    });
    expect(failure.body.linkId).toBeTruthy();

    const invalid = await request('POST', '/api/t1/payment-links', {
      ...VALID_LINK,
      concept: '',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      success: false,
      error: 'Ingresa el concepto de pago.',
      errorClass: 'ValidationError',
      code: 'INVALID_PAYMENT_LINK',
    });
  });

  test('customer configuration provides T1 aliases and API trigger mode', () => {
    expect(t1Customer).toEqual({
      label: 'T1 Pagos — Link de pago',
      triggerMode: 'api',
      aliases: ['t1pagos', 't1tienda'],
    });
  });

  test('the Sentry webhook treats T1 events as already alerted', () => {
    expect(isInstantPathEvent({
      tags: [['alert_path', 'instant'], ['service', 't1-pagos-payment-links']],
      culprit: '',
    })).toBe(true);

    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/t1.js — createPaymentLink',
    })).toBe(true);

    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/other.js — handleCallback',
    })).toBe(false);
  });
});

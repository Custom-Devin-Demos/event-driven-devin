/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const demoRequestRoutes = require('../app/routes/verticals/650815a4');
const {
  submitDemoRequest,
  resolveSpecialistRouting,
  buildDemoBrief,
  SPECIALIST_ROUTING,
} = require('../app/services/verticals/650815a4');

const VALID_REQUEST = {
  workEmail: 'jordan.lee@sterlingmedia.example',
  firstName: 'Jordan',
  lastName: 'Lee',
  company: 'Sterling Media Group',
  role: 'VP of Media Operations',
  product: 'prisma',
  region: 'north_america',
  message: 'Looking to consolidate media buying and billing workflows.',
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'jordan.lee@sterlingmedia.example',
};

const NIVO_EMEA_ROUTING = {
  team: 'NIVO AI Specialists — EMEA',
  responseSlaHours: 24,
};

function postRequest(body) {
  const app = express();
  app.use(express.json());
  app.use(demoRequestRoutes);

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
          path: '/api/650815a4/demo-request',
          method: 'POST',
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

afterEach(() => {
  delete SPECIALIST_ROUTING.prisma;
  createSessionAndAlert.mockClear();
});

describe('Mediaocean demo request routing', () => {
  test('routes a registered product and region', async () => {
    const result = await submitDemoRequest({
      ...VALID_REQUEST,
      product: 'nivo',
      region: 'emea',
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^MO-[0-9A-F]{8}$/);
    expect(result.status).toBe('scheduled');
    expect(result.product.label).toBe('NIVO AI');
    expect(result.region).toBe('EMEA');
    expect(result.routing.team).toBe('NIVO AI Specialists — EMEA');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('builds a demo brief from a registered routing assignment', () => {
    const result = buildDemoBrief('MO-12345678', VALID_REQUEST, NIVO_EMEA_ROUTING);

    expect(result.status).toBe('scheduled');
    expect(result.product.key).toBe('prisma');
    expect(result.routing).toEqual(NIVO_EMEA_ROUTING);
  });
});

describe('Mediaocean default product routing gap', () => {
  test('has no routing entry keyed under the prisma product id', () => {
    expect(() => resolveSpecialistRouting('prisma', 'north_america')).toThrow(TypeError);
  });

  test('raises a TypeError and sends the Cognition identity to the alert flow', async () => {
    await expect(submitDemoRequest(VALID_REQUEST)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('650815a4');
    expect(alert.service).toBe('customer-650815a4-demo-request');
    expect(alert.culprit).toBe('app/services/verticals/650815a4.js — buildDemoBrief');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.errorValue).toMatch(/Cannot read properties of undefined/);
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/650815a4/demo-request' },
      { key: 'product', value: 'prisma' },
      { key: 'region', value: 'north_america' },
    ]));
  });

  test('returns a 500 response for the default prisma demo request', async () => {
    const { status, body } = await postRequest(VALID_REQUEST);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'north_america'\)/);
    expect(body.code).toBe('DEMO_REQUEST_FAILED');
  });
});

describe('Mediaocean demo request fixed behavior', () => {
  test('routes the default product once prisma is keyed by its product id', async () => {
    SPECIALIST_ROUTING.prisma = { ...SPECIALIST_ROUTING.prisma_media };

    const result = await submitDemoRequest(VALID_REQUEST);

    expect(result.success).toBe(true);
    expect(result.routing.team).toBe('Prisma Solutions — Americas');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Mediaocean demo request validation', () => {
  test('rejects incomplete contact details without creating an alert', async () => {
    const { status, body } = await postRequest({ ...VALID_REQUEST, workEmail: '' });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('CONTACT_DETAILS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unsupported product without creating an alert', async () => {
    await expect(submitDemoRequest({ ...VALID_REQUEST, product: 'spectrum' }))
      .rejects.toThrow(/Select a valid product and region/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

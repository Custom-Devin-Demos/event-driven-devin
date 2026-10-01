/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const mpiRoutes = require('../app/routes/verticals/0a537b71');
const {
  submitInspection,
  REPAIR_ORDER,
  OP_CODES,
} = require('../app/services/verticals/0a537b71');

function callApi(path, method, body) {
  const app = express();
  app.use(express.json());
  app.use(mpiRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers },
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

const VALID_REQUEST = {
  repairOrderId: REPAIR_ORDER.id,
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'service.advisor@techyonmotors.example',
};

afterEach(() => {
  createSessionAndAlert.mockClear();
});

describe('Tekion MPI repair-order API', () => {
  test('GET returns the repair order and inspection items', async () => {
    const { status, body } = await callApi('/api/0a537b71/repair-order', 'GET');

    expect(status).toBe(200);
    expect(body.repairOrder.id).toBe('RO-0410875');
    expect(body.repairOrder.vin).toBe('1HGCM82633A004352');
    expect(body.items.map((section) => section.id)).toEqual(
      expect.arrayContaining(['tires', 'under-hood']),
    );
  });
});

describe('Tekion MPI submit op-code gap', () => {
  test('the op-code catalog has no entry for the cabin air filter', () => {
    expect(OP_CODES['uh-cabin-air-filter']).toBeUndefined();
  });

  test('raises a TypeError and sends the Cognition identity to the alert flow', async () => {
    await expect(submitInspection(VALID_REQUEST)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('0a537b71');
    expect(alert.service).toBe('customer-0a537b71-mpi');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('service.advisor@techyonmotors.example');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/0a537b71/submit-mpi' },
      { key: 'repairOrderId', value: REPAIR_ORDER.id },
      { key: 'vin', value: REPAIR_ORDER.vin },
    ]));
  });

  test('returns a 500 response for the default inspection', async () => {
    const { status, body } = await callApi('/api/0a537b71/submit-mpi', 'POST', VALID_REQUEST);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'laborHours'\)/);
    expect(body.code).toBe('MPI_SUBMISSION_FAILED');
  });
});

describe('Tekion MPI submit validation', () => {
  test('rejects an unknown repair order without creating an alert', async () => {
    const { status, body } = await callApi('/api/0a537b71/submit-mpi', 'POST', {
      ...VALID_REQUEST,
      repairOrderId: 'RO-999999',
    });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('UNKNOWN_REPAIR_ORDER');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const powerInquiryRoutes = require('../app/routes/verticals/915a6563');
const {
  submitPowerInquiry,
  resolveProjectRouting,
  buildProjectBrief,
  PROJECT_ROUTING,
} = require('../app/services/verticals/915a6563');

const VALID_INQUIRY = {
  workEmail: 'alex.morgan@northstardata.example',
  firstName: 'Alex',
  lastName: 'Morgan',
  company: 'Northstar Data Systems',
  market: 'data_center',
  capacityNeed: 'hundred_to_five_hundred',
  projectCountry: 'United States',
  projectState: 'California',
  timeline: '12-24 months',
  message: 'Planning firm onsite power for a data center campus.',
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'alex.morgan@northstardata.example',
};

const LARGE_DATA_CENTER_ROUTING = {
  team: 'Strategic Data Center Programs',
  responseSlaHours: 4,
  priority: 'critical',
};

function postInquiry(body) {
  const app = express();
  app.use(express.json());
  app.use(powerInquiryRoutes);

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
          path: '/api/915a6563/power-inquiry',
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
  delete PROJECT_ROUTING.data_center.hundred_to_five_hundred;
  createSessionAndAlert.mockClear();
});

describe('Mainspring Get Power inquiry routing', () => {
  test('routes a registered data center capacity band', async () => {
    const result = await submitPowerInquiry({
      ...VALID_INQUIRY,
      capacityNeed: 'ten_to_fifty',
    });

    expect(result.success).toBe(true);
    expect(result.inquiryId).toMatch(/^MSE-[0-9A-F]{8}$/);
    expect(result.project.market).toBe('Prime Power Data Center Power Supply');
    expect(result.project.designCapacityMw).toBe(25);
    expect(result.project.generatorPackages).toBe(10);
    expect(result.routing.team).toBe('Data Center Solutions');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('builds a project brief from a registered routing assignment', () => {
    const result = buildProjectBrief('MSE-12345678', VALID_INQUIRY, LARGE_DATA_CENTER_ROUTING);

    expect(result.status).toBe('received');
    expect(result.project.capacity).toBe('100 – 500 MW');
    expect(result.project.generatorPackages).toBe(100);
    expect(result.routing).toEqual(LARGE_DATA_CENTER_ROUTING);
  });
});

describe('Mainspring Get Power unregistered capacity band', () => {
  test('has no data center routing entry for the 100 – 500 MW band', () => {
    expect(resolveProjectRouting('data_center', 'hundred_to_five_hundred')).toBeUndefined();
  });

  test('raises a TypeError and sends the Cognition identity to the alert flow', async () => {
    await expect(submitPowerInquiry(VALID_INQUIRY)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('915a6563');
    expect(alert.service).toBe('customer-915a6563-power-inquiry');
    expect(alert.culprit).toBe('app/services/verticals/915a6563.js — buildProjectBrief');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/915a6563/power-inquiry' },
      { key: 'market', value: 'data_center' },
      { key: 'capacity', value: 'hundred_to_five_hundred' },
    ]));
  });

  test('returns a 500 response for the default large data center inquiry', async () => {
    const { status, body } = await postInquiry(VALID_INQUIRY);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'team'\)/);
    expect(body.code).toBe('POWER_INQUIRY_FAILED');
  });
});

describe('Mainspring Get Power fixed behavior', () => {
  test('routes a 100 – 500 MW data center inquiry once the assignment is registered', async () => {
    PROJECT_ROUTING.data_center.hundred_to_five_hundred = { ...LARGE_DATA_CENTER_ROUTING };

    const result = await submitPowerInquiry(VALID_INQUIRY);

    expect(result.success).toBe(true);
    expect(result.routing).toEqual(LARGE_DATA_CENTER_ROUTING);
    expect(result.project.generatorPackages).toBe(100);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns 200 from the API once the assignment is registered', async () => {
    PROJECT_ROUTING.data_center.hundred_to_five_hundred = { ...LARGE_DATA_CENTER_ROUTING };

    const { status, body } = await postInquiry(VALID_INQUIRY);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.routing.team).toBe('Strategic Data Center Programs');
  });
});

describe('Mainspring Get Power validation', () => {
  test('rejects incomplete contact details without creating an alert', async () => {
    const { status, body } = await postInquiry({ ...VALID_INQUIRY, workEmail: '' });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('CONTACT_DETAILS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a request with no JSON body as a validation error', async () => {
    const { status, body } = await postInquiry(undefined);

    expect(status).toBe(400);
    expect(body.code).toBe('CONTACT_DETAILS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unsupported project type without creating an alert', async () => {
    await expect(submitPowerInquiry({ ...VALID_INQUIRY, market: 'residential' }))
      .rejects.toThrow(/Select a valid project type/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

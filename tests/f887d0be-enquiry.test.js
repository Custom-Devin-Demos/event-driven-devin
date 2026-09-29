/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const enquiryRoutes = require('../app/routes/verticals/f887d0be');
const {
  submitEnquiry,
  SCREENING_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/f887d0be');

const VALID_REQUEST = {
  firstName: 'Aoife',
  lastName: 'Murphy',
  email: 'aoife.murphy@northbridge.example',
  company: 'Northbridge Asset Management',
  jobTitle: 'Head of Fund Operations',
  service: 'manco',
  domicile: 'ireland',
  message: 'Evaluating ManCo options for a new UCITS range.',
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'aoife.murphy@northbridge.example',
};

const ORIGINAL_POLICY = {
  concurrency: SCREENING_POLICY.concurrency,
  latencyMs: [...SCREENING_POLICY.latencyMs],
};
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function postRequest(body) {
  const app = express();
  app.use(express.json());
  app.use(enquiryRoutes);

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
          path: '/api/f887d0be/enquiry',
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

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  SCREENING_POLICY.concurrency = ORIGINAL_POLICY.concurrency;
  SCREENING_POLICY.latencyMs = [...ORIGINAL_POLICY.latencyMs];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Waystone enquiry — non-screened service', () => {
  test('returns quickly without screening and does not alert', async () => {
    LATENCY_SLO.budgetMs = 3000;

    const result = await submitEnquiry({
      ...VALID_REQUEST,
      service: 'administration',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^WAY-[0-9A-F]{8}$/);
    expect(result.status).toBe('received');
    expect(result.service.label).toBe('Administration Solutions');
    expect(result.routing.team).toBe('Regulated Fund Solutions — Dublin');
    expect(result.routing.responseSlaHours).toBe(24);
    expect(result.screening).toEqual({ required: false });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Waystone enquiry — latency budget breach', () => {
  test('returns 200 success for the default manco enquiry and schedules a latency alert', async () => {
    SCREENING_POLICY.latencyMs = [5, 10];
    LATENCY_SLO.budgetMs = 60;

    const { status, body } = await postRequest(VALID_REQUEST);
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.reference).toMatch(/^WAY-[0-9A-F]{8}$/);
    expect(body.status).toBe('received');
    expect(body.service).toEqual({ key: 'manco', label: 'AIFMD and UCITS Management Company Solutions' });
    expect(body.domicile).toEqual({ key: 'ireland', label: 'Ireland' });
    expect(body.screening.required).toBe(true);
    expect(body.screening.lists).toBe(18);
    expect(body.screening.parties).toBe(2);
    expect(body.screening.checks).toBe(36);
    expect(body.screening.cleared).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('f887d0be');
    expect(alert.service).toBe('customer-f887d0be-enquiry');
    expect(alert.culprit).toBe('app/services/verticals/f887d0be.js — screenCounterparties');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/f887d0be/enquiry' },
      { key: 'service', value: 'customer-f887d0be-enquiry' },
      { key: 'enquiry_service', value: 'manco' },
      { key: 'domicile', value: 'ireland' },
    ]));
  });
});

describe('Waystone enquiry — raised screening concurrency', () => {
  test('stays under budget at the sanctioned concurrency and does not alert', async () => {
    SCREENING_POLICY.latencyMs = [5, 10];
    SCREENING_POLICY.concurrency = 24;
    LATENCY_SLO.budgetMs = 60;

    const { status, body } = await postRequest(VALID_REQUEST);
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeLessThanOrEqual(LATENCY_SLO.budgetMs);
    expect(body.screening.checks).toBe(36);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Waystone enquiry validation', () => {
  test('rejects a missing required field with a 400 and no alert', async () => {
    const { status, body } = await postRequest({ ...VALID_REQUEST, email: '' });
    await tick();

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('CONTACT_DETAILS_REQUIRED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

/* global afterEach, beforeEach, describe, expect, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: {} })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const routes = require('../app/routes/verticals/7c3e9a52');
const {
  BUSINESS_TYPES,
  PRODUCT_INTERESTS,
  PREFILL,
  PROCESSOR_PLATFORMS,
  PROCESSOR_CHECK_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/7c3e9a52');

const ORIGINAL_LATENCY = [...PROCESSOR_CHECK_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const REQUEST_ID = /^NMI-TTT-[0-9A-F]{6}$/;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

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

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function postLatencyBreach(devinOrgId = 'presenter-org') {
  const response = await request('POST', '/api/7c3e9a52/contact-requests', {
    ...PREFILL,
    devinUserId: 'presenter-user',
    devinOrgId,
    devinEmail: 'presenter@example.com',
  });
  await tick();
  return response;
}

beforeEach(() => resetLatencyAlertCooldowns());

afterEach(() => {
  PROCESSOR_CHECK_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('NMI Talk to Our Team contact requests', () => {
  test('serves form config and routes the default Software/SaaS request with ordered processor coverage', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [0, 0];

    const config = await request('GET', '/api/7c3e9a52/config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      success: true,
      options: { businessTypes: BUSINESS_TYPES, productInterests: PRODUCT_INTERESTS },
      prefill: PREFILL,
      budgetMs: 3000,
    });

    const defaultRequest = { ...PREFILL };
    delete defaultRequest.businessType;
    delete defaultRequest.productInterest;
    const { status, body } = await request('POST', '/api/7c3e9a52/contact-requests', defaultRequest);
    const expectedCoverage = PROCESSOR_PLATFORMS.map(({ name, certified }) => ({
      processor: name,
      certified,
    }));

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(REQUEST_ID),
      request: {
        status: 'submitted',
        businessType: 'software-saas',
        businessTypeLabel: 'Software/SaaS Company',
        productInterest: 'payment-gateway',
        productInterestLabel: 'Payment gateway',
        contact: {
          name: 'Jordan Ellis',
          email: PREFILL.email,
          company: PREFILL.company,
          phone: PREFILL.phone,
        },
        routedTo: {
          team: 'ISV Partnerships',
          name: 'Morgan Hale',
          title: 'Partner Solutions Consultant, ISV & SaaS',
          email: 'mhale@nmi.example',
        },
        processorCoverage: expectedCoverage,
        certifiedProcessors: expectedCoverage.filter(({ certified }) => certified).length,
      },
      timing: { budgetMs: 3000, processorsChecked: 14 },
    });
    expect(body.request.id).toBe(body.requestId);
    expect(body.request.nextStep).toBe(
      'Thanks, Jordan! Morgan Hale from our ISV Partnerships team will reach out within 1 business day.',
    );
    expect(PROCESSOR_PLATFORMS).toHaveLength(14);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('uses a single simulated lookup for non-default business types', async () => {
    const startedAt = Date.now();
    const { status, body } = await request('POST', '/api/7c3e9a52/contact-requests', {
      ...PREFILL,
      businessType: 'bank',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.request.businessType).toBe('bank');
    expect(body.request.routedTo.team).toBe('Financial Institution Partnerships');
    expect(body.request.processorCoverage).toEqual([]);
    expect(body.timing.processorsChecked).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('schedules a latency-breach alert while returning the successful request', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/7c3e9a52/contact-requests', {
      ...PREFILL,
      devinUserId: 'presenter-user',
      devinOrgId: 'presenter-org',
      devinEmail: 'presenter@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.timing.processorsChecked).toBe(14);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/7c3e9a52\/contact-requests took \d+ms \(budget 1ms\)$/);
    expect(alert.customer).toBe('7c3e9a52');
    expect(alert.service).toBe('customer-7c3e9a52-talk-to-our-team');
    expect(alert.culprit).toBe('app/services/verticals/7c3e9a52.js — assessProcessorCoverage');
    expect(alert.devinUserId).toBe('presenter-user');
    expect(alert.devinOrgId).toBe('presenter-org');
    expect(alert.slackMemberId).toBe('');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.promptAppendix).toContain('assessProcessorCoverage');
    expect(alert.promptAppendix).toContain('Promise.all');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/7c3e9a52/contact-requests' },
      { key: 'business_type', value: 'software-saas' },
      { key: 'duration_ms', value: String(body.timing.totalMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      budgetMs: 1,
      processorsChecked: 14,
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when session creation returns null', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce(null);

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('releases the cooldown when the global session cap throttles the alert', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce({ session: null, throttled: true });

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('keeps latency-breach cooldowns independent by organization', async () => {
    PROCESSOR_CHECK_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-b');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ ...PREFILL, firstName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, lastName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, company: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, email: '' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, email: 'not-an-email' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, phone: '555-1234' }, 'INVALID_PHONE'],
    [{ ...PREFILL, businessType: 'unsupported' }, 'INVALID_BUSINESS_TYPE'],
    [{ ...PREFILL, productInterest: 'unsupported' }, 'INVALID_PRODUCT_INTEREST'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const { status, body: response } = await request(
      'POST',
      '/api/7c3e9a52/contact-requests',
      body,
    );
    expect(status).toBe(400);
    expect(response).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(REQUEST_ID),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

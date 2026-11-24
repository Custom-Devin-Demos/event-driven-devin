/* global afterEach, beforeEach, describe, expect, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: {} })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const routes = require('../app/routes/verticals/d44fc556');
const {
  ENQUIRY_TYPES,
  COUNTRIES,
  PREFILL,
  RELATIONSHIP_DESKS,
  DESK_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/d44fc556');

const ORIGINAL_LATENCY = [...DESK_LOOKUP_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const REQUEST_ID = /^WMC-ENQ-[0-9A-F]{6}$/;

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
  const response = await request('POST', '/api/d44fc556/enquiries', {
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
  DESK_LOOKUP_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Wellington contact-us enquiries', () => {
  test('serves form config and office list', async () => {
    const config = await request('GET', '/api/d44fc556/config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      success: true,
      options: { enquiryTypes: ENQUIRY_TYPES, countries: COUNTRIES },
      prefill: PREFILL,
      budgetMs: 3000,
    });

    const offices = await request('GET', '/api/d44fc556/offices');
    expect(offices.status).toBe(200);
    expect(offices.body.offices).toHaveLength(RELATIONSHIP_DESKS.length);
    expect(offices.body.offices[0]).toEqual({ office: 'Boston', desk: RELATIONSHIP_DESKS[0].name });
  });

  test('routes the default product enquiry to the covering relationship desk', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [0, 0];

    const defaultEnquiry = { ...PREFILL };
    delete defaultEnquiry.enquiryType;
    const { status, body } = await request('POST', '/api/d44fc556/enquiries', defaultEnquiry);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(REQUEST_ID),
      enquiry: {
        status: 'submitted',
        enquiryType: 'product-invest',
        enquiryLabel: 'I want information on a product or I want to invest',
        contact: {
          name: 'Priya Raman',
          email: PREFILL.email,
          company: PREFILL.company,
          country: 'United States',
        },
        routedTo: {
          office: 'Boston',
          desk: 'North America Institutional — Boston',
          name: 'Elizabeth Carver',
        },
      },
      timing: { budgetMs: 3000, desksChecked: 14 },
    });
    expect(body.enquiry.id).toBe(body.requestId);
    expect(RELATIONSHIP_DESKS).toHaveLength(14);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['Japan', 'Tokyo'],
    ['Germany', 'Frankfurt'],
    ['Other', 'Radnor'],
  ])('routes %s product enquiries to %s', async (country, office) => {
    DESK_LOOKUP_POLICY.latencyMs = [0, 0];
    const { status, body } = await request('POST', '/api/d44fc556/enquiries', { ...PREFILL, country });
    expect(status).toBe(200);
    expect(body.enquiry.routedTo.office).toBe(office);
    expect(body.timing.desksChecked).toBe(14);
  });

  test.each([
    'job-opportunities',
    'report-scam',
    'employment-verification',
    'technical-issue',
    'corporate-access',
  ])('uses a single specialist lookup for %s enquiries', async (enquiryType) => {
    const startedAt = Date.now();
    const { status, body } = await request('POST', '/api/d44fc556/enquiries', { ...PREFILL, enquiryType });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enquiry.enquiryType).toBe(enquiryType);
    expect(body.enquiry.routedTo.email).toMatch(/@wellington\.example$/);
    expect(body.timing.desksChecked).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('schedules a latency-breach alert while returning the successful enquiry', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/d44fc556/enquiries', {
      ...PREFILL,
      devinUserId: 'presenter-user',
      devinOrgId: 'presenter-org',
      devinEmail: 'presenter@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.timing.desksChecked).toBe(14);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/d44fc556\/enquiries took \d+ms \(budget 1ms\)$/);
    expect(alert.customer).toBe('d44fc556');
    expect(alert.service).toBe('customer-d44fc556-contact-enquiry');
    expect(alert.culprit).toBe('app/services/verticals/d44fc556.js — matchRelationshipDesks');
    expect(alert.devinUserId).toBe('presenter-user');
    expect(alert.devinOrgId).toBe('presenter-org');
    expect(alert.slackMemberId).toBe('');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.promptAppendix).toContain('matchRelationshipDesks');
    expect(alert.promptAppendix).toContain('Promise.all');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/d44fc556/enquiries' },
      { key: 'enquiry_type', value: 'product-invest' },
      { key: 'duration_ms', value: String(body.timing.totalMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      budgetMs: 1,
      desksChecked: 14,
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when session creation returns null', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce(null);

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('releases the cooldown when the global session cap throttles the alert', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce({ session: null, throttled: true });

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('keeps latency-breach cooldowns independent by organization', async () => {
    DESK_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-b');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ ...PREFILL, enquiryType: 'mutual-funds' }, 'INVALID_ENQUIRY_TYPE'],
    [{ ...PREFILL, enquiryType: null }, 'INVALID_ENQUIRY_TYPE'],
    [{ ...PREFILL, email: '' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, email: 'not-an-email' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, firstName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, company: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, country: '' }, 'COUNTRY_REQUIRED'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const { status, body: response } = await request('POST', '/api/d44fc556/enquiries', body);
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

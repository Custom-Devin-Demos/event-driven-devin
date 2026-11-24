/* global afterEach, beforeEach, describe, expect, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const routes = require('../app/routes/verticals/65ee9e8f');
const {
  ORGANIZATION_TYPES,
  COMPANY_SIZES,
  COUNTRIES,
  PREFILL,
  TERRITORY_BOOKS,
  TERRITORY_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/65ee9e8f');

const ORIGINAL_LATENCY = [...TERRITORY_LOOKUP_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

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

async function postLatencyBreach() {
  const response = await request('POST', '/api/65ee9e8f/demo-requests', {
    ...PREFILL,
    devinUserId: 'presenter-user',
    devinOrgId: 'presenter-org',
    devinEmail: 'presenter@example.com',
  });
  await tick();
  return response;
}

beforeEach(() => resetLatencyAlertCooldowns());

afterEach(() => {
  TERRITORY_LOOKUP_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Harvey contact-sales demo requests', () => {
  test('returns the default law-firm request and configured form options', async () => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [0, 0];

    const config = await request('GET', '/api/65ee9e8f/config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      success: true,
      options: {
        organizationTypes: ORGANIZATION_TYPES,
        companySizes: COMPANY_SIZES,
        countries: COUNTRIES,
      },
      prefill: PREFILL,
      budgetMs: 3000,
    });

    const defaultRequest = { ...PREFILL };
    delete defaultRequest.organizationType;
    const { status, body } = await request('POST', '/api/65ee9e8f/demo-requests', defaultRequest);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(/^HRV-DR-[0-9A-F]{5}$/),
      demoRequest: {
        id: expect.stringMatching(/^HRV-DR-[0-9A-F]{5}$/),
        status: 'scheduled',
        contact: {
          name: 'Morgan Ellis',
          email: PREFILL.email,
          company: PREFILL.company,
          jobTitle: PREFILL.jobTitle,
        },
        organizationType: 'law-firm',
        accountOwner: {
          name: 'Jordan Blake',
          title: 'Enterprise Account Executive',
          email: 'jordan.blake@harvey.ai',
          territory: 'Northeast',
        },
        nextStep: 'Your Harvey account executive will reach out within 1 business day to schedule a live demo.',
      },
      timing: {
        budgetMs: 3000,
        territoryBooksChecked: 14,
      },
    });
    expect(body.demoRequest.id).toBe(body.requestId);
    expect(TERRITORY_BOOKS).toHaveLength(14);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    'in-house',
    'professional-services',
    'government',
    'other',
  ])('uses a single territory lookup for %s requests', async (organizationType) => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [0, 0];
    const startedAt = Date.now();

    const { status, body } = await request('POST', '/api/65ee9e8f/demo-requests', {
      ...PREFILL,
      organizationType,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.demoRequest.organizationType).toBe(organizationType);
    expect(body.demoRequest.accountOwner.email).toMatch(/@harvey\.ai$/);
    expect(body.timing.territoryBooksChecked).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('routes other law firms to the mid-market fallback after checking every book', async () => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [0, 0];

    const { status, body } = await request('POST', '/api/65ee9e8f/demo-requests', {
      ...PREFILL,
      company: 'Another Legal LLP',
    });

    expect(status).toBe(200);
    expect(body.demoRequest.accountOwner.territory).toBe('Mid-Market');
    expect(body.timing.territoryBooksChecked).toBe(14);
  });

  test('schedules a latency-breach alert while returning the successful request', async () => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/65ee9e8f/demo-requests', {
      ...PREFILL,
      devinUserId: 'presenter-user',
      devinOrgId: 'presenter-org',
      devinEmail: 'presenter@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.timing.totalMs).toBeGreaterThan(1);
    expect(body.timing.territoryBooksChecked).toBe(14);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('65ee9e8f');
    expect(alert.service).toBe('customer-65ee9e8f-demo-request');
    expect(alert.culprit).toBe('app/services/verticals/65ee9e8f.js — matchFirmAcrossTerritories');
    expect(alert.devinUserId).toBe('presenter-user');
    expect(alert.devinOrgId).toBe('presenter-org');
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe(process.env.HARVEY_SLACK_MEMBER_ID || '');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.promptAppendix).toContain('matchFirmAcrossTerritories');
    expect(alert.promptAppendix).toContain('lookupTerritoryBook');
    expect(alert.promptAppendix).toContain('Promise.all');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/65ee9e8f/demo-requests' },
      { key: 'service', value: 'customer-65ee9e8f-demo-request' },
      { key: 'organization_type', value: 'law-firm' },
      { key: 'duration_ms', value: String(body.timing.totalMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      durationMs: body.timing.totalMs,
      budgetMs: 1,
      territoryBooksChecked: 14,
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when session creation returns null', async () => {
    TERRITORY_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce(null);

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ ...PREFILL, firstName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, lastName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, company: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, email: '' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, email: 'not-an-email' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, organizationType: 'law-office' }, 'INVALID_ORGANIZATION_TYPE'],
    [{ ...PREFILL, organizationType: null }, 'INVALID_ORGANIZATION_TYPE'],
  ])('rejects invalid fields with a structured 400 (%s)', async (body, code) => {
    const { status, body: response } = await request(
      'POST',
      '/api/65ee9e8f/demo-requests',
      body,
    );

    expect(status).toBe(400);
    expect(response).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(/^HRV-DR-[0-9A-F]{5}$/),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

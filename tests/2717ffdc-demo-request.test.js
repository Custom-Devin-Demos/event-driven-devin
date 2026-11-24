/* global afterEach, beforeEach, describe, expect, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: {} })),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const { Sentry } = require('../app/telemetry/sentry');
const routes = require('../app/routes/verticals/2717ffdc');
const {
  BUSINESS_TYPES,
  PREFILL,
  PAYERS,
  PAYER_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/2717ffdc');

const ORIGINAL_LATENCY = [...PAYER_LOOKUP_POLICY.latencyMs];
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

async function postLatencyBreach(devinOrgId = 'presenter-org') {
  const response = await request('POST', '/api/2717ffdc/demo-requests', {
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
  PAYER_LOOKUP_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Careviso seeQer demo requests', () => {
  test('returns the default physician-office request and configured form options', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [0, 0];

    const config = await request('GET', '/api/2717ffdc/config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      success: true,
      options: { businessTypes: BUSINESS_TYPES },
      prefill: PREFILL,
      budgetMs: 3000,
    });

    const defaultRequest = { ...PREFILL };
    delete defaultRequest.businessType;
    const { status, body } = await request(
      'POST',
      '/api/2717ffdc/demo-requests',
      defaultRequest,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(/^CVO-DM-[0-9A-F]{5}$/),
      demoRequest: {
        id: expect.stringMatching(/^CVO-DM-[0-9A-F]{5}$/),
        status: 'scheduled',
        contact: {
          name: 'Dana Whitaker',
          email: PREFILL.email,
        },
        businessType: {
          id: 'physician-office',
          label: 'Physician office/clinic',
        },
        solutionConsultant: {
          name: 'Morgan Reed',
          title: 'seeQer Solution Consultant',
          email: 'morgan.reed@careviso.com',
          region: 'Mid-Atlantic',
        },
        nextStep: 'A seeQer solution consultant will reach out within 1 business day to schedule your demo.',
      },
      timing: {
        budgetMs: 3000,
        payersChecked: 14,
      },
    });

    expect(body.demoRequest.id).toBe(body.requestId);
    expect(body.demoRequest.payerSnapshot.map(({ payer }) => payer)).toEqual(PAYERS);
    body.demoRequest.payerSnapshot.forEach((profile, index) => {
      expect(profile).toMatchObject({ payer: PAYERS[index] });
      expect(['real-time', 'portal']).toContain(profile.benefitsVerification);
      expect(typeof profile.priorAuthCommon).toBe('boolean');
    });

    const repeatedRequest = await request(
      'POST',
      '/api/2717ffdc/demo-requests',
      defaultRequest,
    );
    expect(repeatedRequest.status).toBe(200);
    expect(repeatedRequest.body.demoRequest.payerSnapshot).toEqual(body.demoRequest.payerSnapshot);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['laboratory-rcm', 'Medicare Part B'],
    ['pharma-hub', 'UnitedHealthcare'],
    ['other-provider', 'Aetna'],
  ])('uses one representative payer for %s requests', async (businessType, payer) => {
    PAYER_LOOKUP_POLICY.latencyMs = [0, 0];
    const startedAt = Date.now();

    const { status, body } = await request('POST', '/api/2717ffdc/demo-requests', {
      ...PREFILL,
      businessType,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.demoRequest.businessType.id).toBe(businessType);
    expect(body.demoRequest.payerSnapshot.map(({ payer: payerName }) => payerName)).toEqual([payer]);
    expect(body.demoRequest.solutionConsultant.email).toMatch(/@careviso\.com$/);
    expect(body.demoRequest.solutionConsultant.name).not.toBe('Morgan Reed');
    expect(body.timing.payersChecked).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('schedules a latency-breach alert and returns the successful request', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/2717ffdc/demo-requests', {
      ...PREFILL,
      devinUserId: 'presenter-user',
      devinOrgId: 'presenter-org',
      devinEmail: 'presenter@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.timing.totalMs).toBeGreaterThan(1);
    expect(body.timing.payersChecked).toBe(14);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LatencyBudgetExceeded' }),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          route: '/api/2717ffdc/demo-requests',
          service: 'customer-2717ffdc-demo-request',
          alert_path: 'latency',
        }),
      }),
    );

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('2717ffdc');
    expect(alert.service).toBe('customer-2717ffdc-demo-request');
    expect(alert.culprit).toBe('app/services/verticals/2717ffdc.js — buildPayerCoverageSnapshot');
    expect(alert.devinUserId).toBe('presenter-user');
    expect(alert.devinOrgId).toBe('presenter-org');
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe(process.env.CAREVISO_SLACK_MEMBER_ID || '');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.promptAppendix).toContain('buildPayerCoverageSnapshot');
    expect(alert.promptAppendix).toContain('fetchPayerPolicyProfile');
    expect(alert.promptAppendix).toContain('Promise.all');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/2717ffdc/demo-requests' },
      { key: 'service', value: 'customer-2717ffdc-demo-request' },
      { key: 'business_type', value: 'physician-office' },
      { key: 'duration_ms', value: String(body.timing.totalMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      durationMs: body.timing.totalMs,
      budgetMs: 1,
      payersChecked: 14,
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when session creation returns null', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce(null);

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('releases the cooldown when the global session cap throttles the alert', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce({ session: null, throttled: true });

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('keeps latency-breach cooldowns independent by organization', async () => {
    PAYER_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach('org-a');
    await postLatencyBreach('org-b');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ ...PREFILL, firstName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, lastName: '' }, 'CONTACT_DETAILS_REQUIRED'],
    [{ ...PREFILL, email: '' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, email: 'not-an-email' }, 'INVALID_EMAIL'],
    [{ ...PREFILL, businessType: 'hospital' }, 'INVALID_BUSINESS_TYPE'],
    [{ ...PREFILL, businessType: null }, 'INVALID_BUSINESS_TYPE'],
  ])('rejects invalid fields with a structured 400 (%s)', async (body, code) => {
    const { status, body: response } = await request(
      'POST',
      '/api/2717ffdc/demo-requests',
      body,
    );

    expect(status).toBe(400);
    expect(response).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(/^CVO-DM-[0-9A-F]{5}$/),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

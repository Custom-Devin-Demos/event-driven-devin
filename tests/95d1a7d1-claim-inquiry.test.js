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
  inquireClaim,
  listClaims,
  CLAIM_MASTER,
  CLAIM_POSITIONS,
} = require('../app/services/verticals/95d1a7d1');
const router = require('../app/routes/verticals/95d1a7d1');

const baseRequest = {
  claimId: 'CLM0000101',
  userId: 'INQUSR01',
  devinUserId: 'user-1',
  devinOrgId: 'org-1',
  devinEmail: '',
};

describe('HCPS claims inquiry (95d1a7d1)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('every claim master record has at least one position line', () => {
    for (const record of CLAIM_MASTER) {
      expect(CLAIM_POSITIONS[record.claimId].length).toBeGreaterThan(0);
    }
  });

  test('medical claim inquiry decodes the record and totals the position lines', async () => {
    const result = await inquireClaim(baseRequest);

    expect(result.success).toBe(true);
    expect(result.message).toBe('CLAIM FOUND - INQUIRY COMPLETE');
    expect(result.claim.status).toBe('CLOSED');
    expect(result.claim.memberType).toBe('INDIVIDUAL');
    expect(result.claim.serviceType).toBe('MEDICAL');
    expect(result.financial.charged).toBe(263);
    expect(result.financial.allowed).toBe(169);
    expect(result.financial.paid).toBe(139);
    expect(result.financial.memberResponsibility).toBe(30);
    expect(result.financial.deductibleRemaining).toBe(1500);
    expect(result.financial.outOfPocketRemaining).toBe(4470);
    expect(result.positions).toHaveLength(2);
    expect(result.positions[0].status).toBe('CLOSED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('dental, pharmacy and vision claims resolve without error', async () => {
    for (const claimId of ['CLM0000238', 'CLM0000305', 'CLM0000512']) {
      const result = await inquireClaim({ ...baseRequest, claimId });
      expect(result.success).toBe(true);
      expect(result.financial.outOfPocketRemaining).toBeGreaterThanOrEqual(0);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a runtime failure raises a direct alert routed to the customer config', async () => {
    await expect(inquireClaim({ ...baseRequest, claimId: 'CLM0000417' })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('95d1a7d1');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('summarizeFinancials');
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.devinOrgId).toBe('org-1');
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe('');
  });

  test('leaves the on-call mention to the identity email when one is supplied', async () => {
    await expect(inquireClaim({ ...baseRequest, claimId: 'CLM0000417', devinEmail: 'ops@devindemos.com' })).rejects.toThrow(TypeError);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe('');
  });

  test('malformed claim ids are rejected before any lookup', async () => {
    await expect(inquireClaim({ ...baseRequest, claimId: '12345' })).rejects.toMatchObject({
      name: 'ValidationError',
      status: 400,
      code: 'INVALID_CLAIM_ID',
    });
    await expect(inquireClaim({ ...baseRequest, userId: 'way-too-long-user' })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'INVALID_USER_ID',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('unknown claims return not found without raising an alert', async () => {
    await expect(inquireClaim({ ...baseRequest, claimId: 'CLM9999999' })).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      code: 'CLAIM_NOT_FOUND',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('listClaims exposes every master record with decoded labels', () => {
    const claims = listClaims();
    expect(claims).toHaveLength(CLAIM_MASTER.length);
    expect(claims.find((c) => c.claimId === 'CLM0000417').serviceType).toBe('BEHAVIORAL');
  });
});

describe('HCPS claims inquiry v1 contract (95d1a7d1)', () => {
  let server;
  let headers;

  function request(method, path, extraHeaders, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
      const req = http.request({ port, path, method, headers: { 'Content-Type': 'application/json', ...extraHeaders } }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const login = await request('POST', '/95d1a7d1/api/v1/auth/login', {}, { userId: 'INQUSER1', password: 'INQUSER1' });
    headers = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    createSessionAndAlert.mockClear();
  });

  test('login issues a bearer token and /auth/me reports the CLMINQ auth level', async () => {
    const me = await request('GET', '/95d1a7d1/api/v1/auth/me', headers);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ userId: 'INQUSER1', authLevel: '03' });

    const bad = await request('POST', '/95d1a7d1/api/v1/auth/login', {}, { userId: 'INQUSER1', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ code: 'UNAUTHENTICATED', returnCode: 8 });
  });

  test('claim detail follows the ClaimDetail schema with two-decimal money strings', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101', headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      returnCode: 0,
      message: 'Claim record retrieved successfully',
      claimId: 'CLM0000101',
      memberType: 'I',
      providerId: 'PRV0001177',
      providerName: 'RIVERSIDE FAMILY MEDICINE',
      status: 'C',
      statusText: 'Closed',
      serviceType: 'MED',
      financial: { charged: '263.00', allowed: '169.00', paid: '139.00', memberResponsibility: '30.00', currency: 'USD' },
    });
  });

  test('missing token is 401 and a user without a SECURITY_AUTH row is 403', async () => {
    const anon = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101', {});
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ code: 'UNAUTHENTICATED', message: 'Sign-on required', returnCode: 8 });

    const login = await request('POST', '/95d1a7d1/api/v1/auth/login', {}, { userId: 'INQUSER9', password: 'INQUSER9' });
    const denied = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101', { Authorization: `Bearer ${login.body.accessToken}` });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ code: 'FORBIDDEN', message: 'No authorization record found', returnCode: 8 });
  });

  test('unknown claim maps RC 4 to 404', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000999', headers);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Claim record not found', returnCode: 4 });
  });

  test('runtime failures map RC 8 to 500 BACKEND_ERROR and raise the alert', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000417', headers);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'BACKEND_ERROR', returnCode: 8 });
    expect(res.body.message).toBe('System error occurred. Contact support.');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].customer).toBe('95d1a7d1');
  });

  test('positions page mirrors POSMAP columns and offset paging', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101/positions?page=1&limit=1', headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returnCode: 0, claimId: 'CLM0000101', page: 1, limit: 1, recordCount: 1, hasMore: true });
    expect(res.body.items[0]).toEqual({
      claimId: 'CLM0000101',
      date: '2026-08-14',
      serviceCode: '99213',
      charged: '215.00',
      allowed: '142.60',
      paid: '112.60',
      status: 'C',
    });
  });

  test('history is fixed at 15 rows ordered by service date then time descending', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101/history', headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returnCode: 0, pageSize: 15, recordCount: 3, hasMore: false });
    expect(res.body.items.map((row) => row.serviceDate)).toEqual(['2026-08-29', '2026-08-21', '2026-08-15']);
    expect(res.body.items[0]).toMatchObject({ claimId: 'CLM0000101', claimType: 'AP', charged: '263.00', paid: '139.00' });
  });

  test('a mismatched memberId on claim detail maps to RC 4', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101?memberId=MBR0000000', headers);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Claim record not found', returnCode: 4 });

    const ok = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101?memberId=MBR0048213', headers);
    expect(ok.status).toBe(200);
    expect(ok.body.memberId).toBe('MBR0048213');
  });

  test('non-positive position limits fall back to the 10-row page', async () => {
    const res = await request('GET', '/95d1a7d1/api/v1/claims/CLM0000101/positions?limit=-1', headers);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.items).toHaveLength(2);
  });
});

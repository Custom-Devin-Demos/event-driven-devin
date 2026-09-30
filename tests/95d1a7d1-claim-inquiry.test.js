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

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function getJson(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }).on('error', reject);
  });
}

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
    expect(alert.slackMemberId).toBe('U09MEGVGG2Z');
    expect(alert.slackMemberIdFallback).toBe('U09MEGVGG2Z');
  });

  test('leaves the on-call mention to the identity email when one is supplied', async () => {
    await expect(inquireClaim({ ...baseRequest, claimId: 'CLM0000417', devinEmail: 'ops@devindemos.com' })).rejects.toThrow(TypeError);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe('U09MEGVGG2Z');
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

  describe('router', () => {
    let server;

    beforeAll((done) => {
      const app = express();
      app.use(express.json());
      app.use(router);
      server = http.createServer(app);
      server.listen(0, done);
    });

    afterAll((done) => {
      server.close(done);
    });

    test('GET /api/95d1a7d1/claims lists the claim master', async () => {
      const res = await getJson(server, '/api/95d1a7d1/claims');
      expect(res.status).toBe(200);
      expect(res.body.claims.map((c) => c.claimId)).toContain('CLM0000101');
    });

    test('POST returns 200 with the decoded claim', async () => {
      const res = await postJson(server, '/api/95d1a7d1/inquiry', baseRequest);
      expect(res.status).toBe(200);
      expect(res.body.claim.claimId).toBe('CLM0000101');
    });

    test('POST maps validation, not-found and runtime errors to status codes', async () => {
      const invalid = await postJson(server, '/api/95d1a7d1/inquiry', { ...baseRequest, claimId: 'nope' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('INVALID_CLAIM_ID');

      const missing = await postJson(server, '/api/95d1a7d1/inquiry', { ...baseRequest, claimId: 'CLM0000999' });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('CLAIM_NOT_FOUND');

      const failed = await postJson(server, '/api/95d1a7d1/inquiry', { ...baseRequest, claimId: 'CLM0000417' });
      expect(failed.status).toBe(500);
      expect(failed.body.errorClass).toBe('TypeError');
      expect(failed.body.code).toBe('CLAIM_INQUIRY_FAILED');
    });
  });
});

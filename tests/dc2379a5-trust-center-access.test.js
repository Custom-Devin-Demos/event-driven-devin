/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const trustCenterRoutes = require('../app/routes/verticals/dc2379a5');
const {
  requestTrustCenterAccess,
  buildAccessGrants,
  TRUST_DOCUMENTS,
  FRAMEWORK_ACCESS_POLICIES,
} = require('../app/services/verticals/dc2379a5');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'grc@vanta.example',
};

const REQUESTER = {
  fullName: 'Jordan Lee',
  workEmail: 'jordan.lee@northwindhealth.com',
  company: 'Northwind Health',
  reason: 'Vendor security review',
  ndaAccepted: true,
};

function postRequest(body) {
  const app = express();
  app.use(express.json());
  app.use(trustCenterRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/dc2379a5/trust-center/access-requests',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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
  delete FRAMEWORK_ACCESS_POLICIES.iso42001;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Vanta Trust Center access requests', () => {
  test('auto-approves SOC 2 and ISO 27001 documents', async () => {
    const result = await requestTrustCenterAccess({
      ...REQUESTER,
      documents: ['soc2-type2-report', 'iso27001-certificate'],
      ...IDENTITY,
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^VTR-[0-9A-F]{8}$/);
    expect(result.status).toBe('approved');
    expect(result.deliveredTo).toBe('jordan.lee@northwindhealth.com');
    expect(result.grants).toEqual([
      expect.objectContaining({ documentId: 'soc2-type2-report', framework: 'SOC 2 Type II', status: 'approved' }),
      expect.objectContaining({ documentId: 'iso27001-certificate', framework: 'ISO 27001:2022', status: 'approved' }),
    ]);
    result.grants.forEach((grant) => expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now()));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('routes HIPAA and penetration test documents to manual review', async () => {
    const result = await requestTrustCenterAccess({
      ...REQUESTER,
      documents: ['soc2-type2-report', 'hipaa-attestation', 'pentest-summary'],
    });

    expect(result.status).toBe('pending_review');
    expect(result.grants.map((grant) => grant.status)).toEqual(['approved', 'pending_review', 'pending_review']);
    expect(result.grants[1].expiresAt).toBeNull();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...REQUESTER, fullName: ' ', documents: ['soc2-type2-report'] }, 'INVALID_NAME'],
    [{ ...REQUESTER, workEmail: 'not-an-email', documents: ['soc2-type2-report'] }, 'INVALID_EMAIL'],
    [{ ...REQUESTER, workEmail: 'jordan@gmail.com', documents: ['soc2-type2-report'] }, 'WORK_EMAIL_REQUIRED'],
    [{ ...REQUESTER, company: '', documents: ['soc2-type2-report'] }, 'INVALID_COMPANY'],
    [{ ...REQUESTER, documents: [] }, 'INVALID_DOCUMENTS'],
    [{ ...REQUESTER, documents: ['pci-aoc'] }, 'INVALID_DOCUMENTS'],
    [{ ...REQUESTER, ndaAccepted: false, documents: ['soc2-type2-report'] }, 'NDA_REQUIRED'],
  ])('rejects invalid request %# with a 400 and no alert', async (body, code) => {
    const { status, body: response } = await postRequest(body);

    expect(status).toBe(400);
    expect(response.errorClass).toBe('ValidationError');
    expect(response.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Vanta ISO 42001 Certificate request', () => {
  test('has no access policy under the framework the document declares', () => {
    expect(TRUST_DOCUMENTS['iso42001-certificate'].framework).toBe('iso42001');
    expect(FRAMEWORK_ACCESS_POLICIES.iso42001).toBeUndefined();
    expect(() => buildAccessGrants(['iso42001-certificate'])).toThrow(TypeError);
  });

  test('raises a TypeError and forwards the hub identity to the alert flow', async () => {
    await expect(
      requestTrustCenterAccess({
        ...REQUESTER,
        documents: ['soc2-type2-report', 'iso27001-certificate', 'iso42001-certificate'],
        ...IDENTITY,
      }),
    ).rejects.toThrow("Cannot read properties of undefined (reading 'ndaTemplate')");

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('dc2379a5');
    expect(alert.service).toBe('customer-dc2379a5-trust-center-access');
    expect(alert.culprit).toBe('app/services/verticals/dc2379a5.js — buildAccessGrants');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('grc@vanta.example');
    expect(alert.slackMemberId).toBeUndefined();
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/dc2379a5/trust-center/access-requests' },
      { key: 'documents', value: 'soc2-type2-report|iso27001-certificate|iso42001-certificate' },
    ]));
  });

  test('tags the Sentry event so the webhook does not raise a second alert', async () => {
    await expect(
      requestTrustCenterAccess({ ...REQUESTER, documents: ['iso42001-certificate'], ...IDENTITY }),
    ).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/dc2379a5.js \u2014 buildAccessGrants',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'buildAccessGrants', tags: [['alert_path', 'instant']] })).toBe(true);
  });

  test('returns a 500 response from the route', async () => {
    const { status, body } = await postRequest({ ...REQUESTER, documents: ['iso42001-certificate'], ...IDENTITY });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'ndaTemplate'\)/);
    expect(body.code).toBe('ACCESS_REQUEST_FAILED');
  });
});

describe('Vanta ISO 42001 fixed behavior', () => {
  test('approves the certificate once the framework resolves to its policy', async () => {
    FRAMEWORK_ACCESS_POLICIES.iso42001 = FRAMEWORK_ACCESS_POLICIES['iso-42001'];

    const result = await requestTrustCenterAccess({ ...REQUESTER, documents: ['iso42001-certificate'], ...IDENTITY });

    expect(result.status).toBe('approved');
    expect(result.grants).toEqual([
      expect.objectContaining({ documentId: 'iso42001-certificate', framework: 'ISO 42001:2023', status: 'approved' }),
    ]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

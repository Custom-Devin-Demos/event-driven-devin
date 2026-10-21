/* global afterAll, beforeEach, describe, expect, test */

const express = require('express');
const http = require('http');

const {
  submitPriorAuth,
  releaseAccumulatedPriorAuthRecords,
} = require('../app/services/oncall-verticals/priorauth');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

const VALID_REQUEST = {
  memberId: 'LSHP-100245-01',
  providerNpi: '1316024598',
  cptCode: '70553',
  icd10: 'G43.909',
  serviceDate: '2026-10-08',
  urgency: 'standard',
  clinicalNotes: 'Recurring headaches with visual aura.',
};

beforeEach(() => {
  releaseAccumulatedPriorAuthRecords();
});

describe('prior authorization submissions', () => {
  test('rejects ineligible members and unknown procedures quickly', async () => {
    const memberStarted = Date.now();
    await expect(submitPriorAuth({
      ...VALID_REQUEST,
      memberId: 'LSHP-311902-01',
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_ELIGIBLE' });
    expect(Date.now() - memberStarted).toBeLessThan(500);

    const procedureStarted = Date.now();
    await expect(submitPriorAuth({
      ...VALID_REQUEST,
      cptCode: '99999',
    })).rejects.toMatchObject({ code: 'PROCEDURE_NOT_FOUND' });
    expect(Date.now() - procedureStarted).toBeLessThan(500);
  });

  test('returns NOT_REQUIRED quickly for a procedure without an authorization policy', async () => {
    const started = Date.now();
    const result = await submitPriorAuth({
      ...VALID_REQUEST,
      cptCode: '99213',
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({
      success: true,
      status: 'NOT_REQUIRED',
      memberId: VALID_REQUEST.memberId,
      cptCode: '99213',
    });
  });

  test('returns a successful decision and makes the next submission slower', async () => {
    const first = await submitPriorAuth(VALID_REQUEST, { synthetic: true });
    const second = await submitPriorAuth(VALID_REQUEST, { synthetic: true });

    expect(first).toMatchObject({
      success: true,
      authId: expect.stringMatching(/^PA-[0-9A-F]{8}$/),
      status: 'PENDED_FOR_CLINICAL_REVIEW',
      memberId: VALID_REQUEST.memberId,
      cptCode: VALID_REQUEST.cptCode,
    });
    expect(second.authId).toBe(first.authId);
    expect(second.durationMs).toBeGreaterThan(first.durationMs + 500);
  });
});

describe('POST /api/oncall/payer/prior-auth', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(oncallVerticalRoutes);
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => stopGateway().then(() => done()));
  });

  test('returns a prior-authorization ID for a valid request', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/payer/prior-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_REQUEST, urgency: 'urgent' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      authId: expect.stringMatching(/^PA-[0-9A-F]{8}$/),
      status: 'APPROVED',
      memberId: VALID_REQUEST.memberId,
      cptCode: VALID_REQUEST.cptCode,
      durationMs: expect.any(Number),
    });
  });
});

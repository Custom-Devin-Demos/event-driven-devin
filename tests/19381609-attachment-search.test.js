/* global beforeEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const router = require('../app/routes/verticals/19381609');
const {
  search,
  getAccountPolicies,
  ATTACHMENTS,
  ACCOUNTS,
} = require('../app/services/verticals/19381609');

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = 'applied-test-request'; next(); });
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        method,
        port: server.address().port,
        path,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        });
      });
      req.on('error', (error) => { server.close(); reject(error); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('Applied Epic (19381609) global search', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists agency accounts and account policies with Epic line descriptions', async () => {
    const accounts = await request('GET', '/api/19381609/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toHaveLength(ACCOUNTS.length);

    const policies = await request('GET', '/api/19381609/accounts/HARTLOG-01/policies');
    expect(policies.status).toBe(200);
    expect(policies.body.account.name).toBe('Hartwell Logistics, Inc.');
    expect(policies.body.policies[0]).toMatchObject({ line: 'WCOM', lineDescription: "Worker's Compensation", agency: 'INS', branch: 'MAT' });
    expect(getAccountPolicies('NOPE-01')).toBeNull();
    expect((await request('GET', '/api/19381609/accounts/NOPE-01/policies')).status).toBe(404);
  });

  test('attachment search for batch 7186051 groups results by account', async () => {
    const response = await request('POST', '/api/19381609/search', { query: '7186051', type: 'attachment' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, totalResults: 3, accountCount: 3 });
    const hartwell = response.body.accounts.find((account) => account.lookupCode === 'HARTLOG-01');
    expect(hartwell.attachments[0]).toMatchObject({
      client: 'Hartwell Logistics, Inc. (HARTLOG-01)',
      attachedDate: '10/20/2026',
      attachedTo: 'Policy GLIA — General Liability · CPP 2848019 · 06/01/2026–06/01/2027',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('status and date filters narrow attachment results', async () => {
    const inactive = await search({ query: 'hartwell', status: 'inactive' });
    expect(inactive.totalResults).toBe(1);
    expect(inactive.accounts[0].attachments[0].attachedTo).toBe('Account — Hartwell Logistics, Inc.');
    const recent = await search({ query: 'acord 125', date: '30d' }, { now: '2026-10-29T12:00:00Z' });
    expect(recent.totalResults).toBe(0);
  });

  test('account and policy searches succeed', async () => {
    const accounts = await search({ query: 'brew', type: 'account' });
    expect(accounts.accounts.map((account) => account.lookupCode)).toEqual(['SUMMITC-01']);
    const policies = await search({ query: 'CPP 2848019', type: 'policy' });
    expect(policies.accounts[0]).toMatchObject({ lookupCode: 'HARTLOG-01', count: 4 });
  });

  test.each([
    [{ query: 'ab' }, 'SEARCH_QUERY_TOO_SHORT'],
    [{ query: '7186042', type: 'claims' }, 'SEARCH_TYPE_INVALID'],
    [{ query: '7186042', status: 'deleted' }, 'SEARCH_STATUS_INVALID'],
    [{ query: '7186042', date: 'forever' }, 'SEARCH_DATE_INVALID'],
    [{ query: '7186042', sort: 'random' }, 'SEARCH_SORT_INVALID'],
  ])('invalid search %p returns a structured 400', async (body, code) => {
    const response = await request('POST', '/api/19381609/search', body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: expect.any(String),
      errorClass: 'ValidationError',
      code,
      requestId: 'applied-test-request',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a failing search returns 500 and raises an instant-path alert', async () => {
    const original = ATTACHMENTS[0].attachedTo;
    ATTACHMENTS[0].attachedTo = null;
    try {
      const response = await request('POST', '/api/19381609/search', {
        query: '7186042', devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'se@example.com',
      });
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        success: false, errorClass: 'TypeError', code: 'SEARCH_FAILED', requestId: 'applied-test-request',
      });
    } finally {
      ATTACHMENTS[0].attachedTo = original;
    }
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({
      tags: expect.objectContaining({ alert_path: 'instant', service: 'customer-19381609-attachment-search' }),
    }));
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '19381609',
      culprit: 'app/services/verticals/19381609.js — describeAttachedTo',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'se@example.com',
      promptAppendix: expect.stringContaining('app/services/verticals/19381609.js'),
    }));
  });
});

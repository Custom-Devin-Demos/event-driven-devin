jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../app/telemetry/logger', () => ({ error: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue(null) }));

const express = require('express');
const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const router = require('../app/routes/verticals/ca610f30');
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => jest.clearAllMocks());

async function signup(body) {
  const response = await fetch(base + '/api/ca610f30/memberships', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test.each(['standard_ads_2025', 'standard_2025'])('%s provisions playback and a membership', async planSku => {
  const result = await signup({ email: 'demo@example.com', planSku });
  expect(result.status).toBe(200);
  expect(result.body.membershipId).toMatch(/^NFX-[A-F0-9]{8}$/);
  expect(result.body.playback.maxConcurrentStreams).toBe(2);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('default Premium fails at provisioning, captures no PII and routes the incident', async () => {
  const result = await signup({ email: 'demo@example.com', devinEmail: 'presenter@example.com', devinUserId: 'user', devinOrgId: 'org' });
  expect(result.status).toBe(500);
  expect(result.body.errorClass).toBe('TypeError');
  expect(result.body.error).toBe("Cannot read properties of undefined (reading 'maxConcurrentStreams')");
  expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({
    extra: { membershipId: expect.stringMatching(/^NFX-/), planSku: 'premium_uhd_2026' },
  }));
  expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
    customer: 'ca610f30', devinUserId: 'user', devinOrgId: 'org', devinEmail: 'presenter@example.com',
    culprit: 'app/services/verticals/ca610f30.js — provisionStreamEntitlement',
  }));
});

test.each([{}, { email: '' }, { email: 'invalid' }, { email: 'demo@example.com', planSku: 'unknown' }, { email: 'demo@example.com', planSku: '__proto__' }])('rejects invalid or empty input: %j', async body => {
  expect((await signup(body)).status).toBe(400);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

const express = require('express');

jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(async () => {
    const { currentAlertDestination } = jest.requireActual('../app/services/alert-destination');
    return { destination: currentAlertDestination() };
  }),
}));

const router = require('../app/routes/verticals/cfe13c8b');
const { resetAvailability } = require('../app/services/verticals/cfe13c8b');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');

const path = '/api/cfe13c8b';
const lookup = { branchId: 'peoria', partNumber: '465-6505' };
const auth = { 'x-session-secret': 'demo-test-secret' };
let server;
let base;
let originalSecret;

beforeAll(async () => {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = auth['x-session-secret'];
  const app = express();
  app.use(express.json(), router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}${path}`;
});

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  resetAvailability({ reports: true });
  jest.clearAllMocks();
});

const post = (route, body, headers = {}) => fetch(base + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('loads the machine-down work order without a dispatch', async () => {
  const response = await fetch(base + '/work-order');
  expect(response.status).toBe(200);
  const { workOrder, branches } = await response.json();
  expect(workOrder).toMatchObject({ id: 'WO-41872', asset: 'EX-320-17', part: { number: '465-6505', quantity: 1 } });
  expect(branches.map(branch => branch.id)).toEqual(['peoria', 'decatur']);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('returns a stock and pickup result for the unchanged feed', async () => {
  const response = await post('/availability', { ...lookup, branchId: 'decatur', reports: 'on' }, auth);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ available: 4, readyBy: 'Today after 3:30 PM' });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test.each([{ branchId: 'other' }, { partNumber: 'other' }])('rejects invalid lookup %p without reporting', async input => {
  const response = await post('/availability', { ...lookup, ...input, reports: 'on' }, auth);
  expect(response.status).toBe(400);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('shows the feed failure without dispatch in default and synthetic modes', async () => {
  const defaultMode = await post('/availability', lookup);
  expect(defaultMode.status).toBe(503);
  expect(await defaultMode.json()).toMatchObject({ code: 'INVENTORY_UNAVAILABLE', requestId: expect.any(String) });
  const synthetic = await post('/availability', { ...lookup, reports: 'on' }, { 'x-synthetic': 'true' });
  expect(synthetic.status).toBe(503);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

test('requires the configured secret for alerting and re-arming', async () => {
  expect((await post('/availability', { ...lookup, reports: 'on' })).status).toBe(401);
  expect((await post('/availability/reset', { reports: 'on' })).status).toBe(401);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('routes one scoped alert to Teams until an explicit verified reset', async () => {
  const fire = () => post('/availability', { ...lookup, reports: 'on', devinEmail: 'presenter@example.com' }, auth);
  const responses = await Promise.all([fire(), fire()]);
  expect(responses.map(response => response.status)).toEqual([503, 503]);
  const requestIds = await Promise.all(responses.map(async response => (await response.json()).requestId));
  expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
    skipVulnerablePr: true,
    customer: 'cfe13c8b',
    devinEmail: 'presenter@example.com',
    errorType: 'TypeError',
    extra: expect.objectContaining({ feedBatch: 'PEO-8821', feedVersion: '2.1', branchId: 'peoria', partNumber: '465-6505' }),
  }));
  expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('slackMemberId');
  expect(requestIds).toContain(createSessionAndAlert.mock.calls[0][0].extra.requestId);
  await expect(createSessionAndAlert.mock.results[0].value).resolves.toEqual({ destination: 'teams' });
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);

  expect((await post('/availability/reset', {})).status).toBe(200);
  expect((await fire()).status).toBe(503);
  expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

  expect((await post('/availability/reset', { reports: 'on' }, auth)).status).toBe(200);
  expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  expect((await fire()).status).toBe(503);
  expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
});

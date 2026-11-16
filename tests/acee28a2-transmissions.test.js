jest.mock('axios');
const axios = require('axios');
const express = require('express');
jest.mock('../app/services/slack', () => ({ postAlertToSlack: jest.fn(), postBugReportToTriage: jest.fn(), postDevinSessionLink: jest.fn() }));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn(), isEnabled: jest.fn() } }));
const { Sentry } = require('../app/telemetry/sentry');
const { postAlertToSlack } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const fs = require('fs');
const path = require('path');
const service = require('../app/services/verticals/acee28a2');
const { reportTransmissionError, buildAlertData } = require('../app/services/verticals/acee28a2-alert');
const { runWithAlertDestination } = require('../app/services/alert-destination');
const router = require('../app/routes/verticals/acee28a2');

const MESSAGE = "Cannot read properties of undefined (reading 'worklist')";
const error = new TypeError(MESSAGE);
const FAILING = 'PT-31803';
const report = (input = {}) => runWithAlertDestination('teams', () => reportTransmissionError(error, input));
const keys = ['NODE_ENV', 'CI', 'LONGITUDE_DEMO_DRY_RUN', 'LOWES_TEAMS_WEBHOOK_URL', 'AUTOMATIONS_TEAMS_WEBHOOK_URL', 'SENTRY_ORG_SLUG', 'SENTRY_PROJECT_ID', 'SENTRY_RELEASE', 'SENTRY_ENVIRONMENT', 'APP_VERSION', 'DD_ENV'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
let testTime = Date.now();
beforeEach(() => { jest.clearAllMocks(); Sentry.isEnabled.mockReturnValue(true); Sentry.captureException.mockReturnValue('0123456789abcdef0123456789abcdef'); keys.forEach(k => delete process.env[k]); testTime += 60_001; jest.spyOn(Date, 'now').mockReturnValue(testTime); });
afterAll(() => jest.restoreAllMocks());
afterAll(() => keys.forEach(k => { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }));

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, body) => fetch(`${base}/api/acee28a2/transmissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('registers the customer and its friendly URLs', () => {
  const { getCustomerConfig, listAliases } = require('../config/customers');
  expect(getCustomerConfig('acee28a2').label).toContain('LONGITUDE');
  expect(listAliases().longitude).toBe('acee28a2');
  expect(listAliases().bsci).toBe('acee28a2');
});

test('the page is labelled synthetic and collects no credentials', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/acee28a2.html'), 'utf8');
  expect(html).toContain('Demo only');
  expect(html).toContain('Not a Boston Scientific product');
  expect(html).not.toContain('type="password"');
  expect(html).not.toMatch(/<img\b/);
});

test('established device models route red and yellow alerts to their worklists', () => {
  expect(service.processTransmission({ patientId: 'PT-10482' }).alert).toMatchObject({ severity: 'red', worklist: 'red-alerts', notify: ['page', 'sms', 'email'], reviewWithinHours: 24 });
  expect(service.processTransmission({ patientId: 'PT-20917' }).alert).toMatchObject({ severity: 'yellow', worklist: 'yellow-alerts' });
});

test('yellow alerts on the new model are the healthy control', () => {
  expect(service.processTransmission({ patientId: 'PT-31266' })).toMatchObject({ success: true, model: 'SICD-A300', alert: { severity: 'yellow', worklist: 'yellow-alerts' } });
});

test('incident baseline: a red alert on the new model has no route', () => {
  expect(() => service.processTransmission({ patientId: FAILING })).toThrow(MESSAGE);
});

test.each([undefined, {}, { patientId: 'PT-0' }, { patientId: '__proto__' }, { patientId: 42 }, { patientId: ['PT-10482'] }])('unknown patients are rejected without an incident: %p', input => {
  expect.assertions(2);
  try { service.processTransmission(input); } catch (e) { expect(e.status).toBe(400); }
  expect(axios.post).not.toHaveBeenCalled();
});

test('the patient list never exposes findings before a transmission is processed', () => withServer(async base => {
  const data = await (await fetch(`${base}/api/acee28a2/patients`)).json();
  expect(data.patients).toHaveLength(service.PATIENTS.length);
  data.patients.forEach(p => expect(p).not.toHaveProperty('finding'));
  expect(data.liveTeams).toBe(false);
}));

test('the failing transmission returns 500 with a rehearsal card and sends nothing', () => withServer(async base => {
  const response = await post(base, { patientId: FAILING });
  const data = await response.json();
  expect(response.status).toBe(500);
  expect(data).toMatchObject({ success: false, code: 'ALERT_ROUTING_FAILED', diagnostic: MESSAGE, alert: { dryRun: true, sent: false } });
  expect(data.alert.payload.text).toContain('customer-acee28a2-alert-routing');
  expect(axios.post).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
  const invalid = await post(base, { patientId: 'nope' });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).alert).toBeUndefined();
}));

test('rehearsal previews the Teams card without Sentry, Teams or a session', async () => {
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  const result = await report({ patientId: FAILING });
  expect(result).toMatchObject({ ok: true, dryRun: true, sent: false, destination: 'teams', reason: 'local-or-test-runtime' });
  expect(result.payload.text).toContain('LONGITUDE Clinic Alert Routing');
  expect(result.payload.text).not.toContain('customer-a4c19e72-checkout');
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

test('hosted mode captures Sentry, then posts once to the dedicated Teams target only', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://shared.webhook.office.com/workflows/other-demos';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  const result = await report({ patientId: FAILING, devinEmail: 'presenter@example.com' });
  expect(result).toMatchObject({ ok: true, sent: true, dryRun: false, responderManaged: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post.mock.calls[0][0]).toBe(process.env.LOWES_TEAMS_WEBHOOK_URL);
  expect(Sentry.captureException).toHaveBeenCalledWith(error, {
    tags: { route: '/api/acee28a2/transmissions', service: 'customer-acee28a2-alert-routing', scenario: 'longitude-red-alert-demo', alert_path: 'instant' },
    extra: { patientId: FAILING },
  });
  expect(Sentry.captureException.mock.invocationCallOrder[0]).toBeLessThan(axios.post.mock.invocationCallOrder[0]);
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test('a second alert inside the cooldown is not sent', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  await report({ patientId: FAILING });
  expect(await report({ patientId: FAILING })).toMatchObject({ ok: false, sent: false, throttled: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('without Teams selected on the hub nothing is sent anywhere', async () => {
  process.env.NODE_ENV = 'production';
  process.env.LOWES_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  const result = await runWithAlertDestination('slack', () => reportTransmissionError(error, { patientId: FAILING }));
  expect(result).toMatchObject({ ok: false, sent: false });
  expect(axios.post).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
});

test('alert data carries only the synthetic patient id', () => {
  const data = buildAlertData(error, { patientId: FAILING, name: 'Demo Patient D' });
  expect(data.extra).toEqual({ patientId: FAILING });
  expect(data).toMatchObject({ customer: 'acee28a2', level: 'critical', skipVulnerablePr: true });
});

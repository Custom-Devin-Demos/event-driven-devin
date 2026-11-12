jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { buildAlertBlocks } = require('../app/services/slack');
const svc = require('../app/services/verticals/8d8c2937');
const router = require('../app/routes/verticals/8d8c2937');
const { getCustomerConfig, listAliases } = require('../config/customers');

const NOW = new Date('2026-11-12T15:00:00Z'); // Thursday
const request = (overrides = {}) => ({
  isPatient: true,
  patient: { firstName: 'Jordan', lastName: 'Ellis', dateOfBirth: '1968-04-12', email: 'jordan.ellis@example.com', phone: '(507) 555-0142' },
  specialty: 'cardiovascular-medicine',
  concern: 'Shortness of breath and an irregular heartbeat on stairs.',
  insurance: { type: 'insurance', carrier: 'Blue Cross and Blue Shield of Minnesota', memberId: 'XKM448120937' },
  campus: 'rochester', contactPreference: 'phone', ...overrides,
});
beforeEach(() => jest.clearAllMocks());

describe('Mayo Clinic registration and assets', () => {
  test('registers the ID slug and friendly aliases without operator impersonation', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Mayo Clinic — Request an Appointment', triggerMode: 'api', githubOrg: 'COG-GTM' });
    for (const alias of ['mayo', 'mayoclinic', 'mayo-clinic']) expect(listAliases()[alias]).toBe('8d8c2937');
    const config = require('../config/customers/8d8c2937');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
    const js = fs.readFileSync(path.join(__dirname, '../app/public/verticals/8d8c2937-assets/request.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`identity('${key}')`);
    expect(js).toContain("'/api/8d8c2937/appointment-requests'");
    expect(js).not.toMatch(/clerk-user_|org-[a-f0-9]{32}/);
  });

  test('page pre-fills the failing path and locally served fonts/logos exist', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/8d8c2937.html'), 'utf8');
    expect(html).toContain('Start your appointment request here.');
    expect(html).toContain('Are you the patient?');
    const js = fs.readFileSync(path.join(__dirname, '../app/public/verticals/8d8c2937-assets/request.js'), 'utf8');
    expect(js).toContain("specialty: 'cardiovascular-medicine'"); expect(js).toContain("campus: 'rochester'");
    for (const asset of ['logo.svg', 'logo.png', 'MayoClinicSans-Regular.woff2', 'MayoClinicSans-Bold.woff2', 'MayoClinicSerifDisplay-Bold.woff2']) {
      expect(fs.statSync(path.join(__dirname, '../app/public/verticals/8d8c2937-assets', asset)).size).toBeGreaterThan(1000);
    }
  });
});

describe('healthy specialties and validation', () => {
  test.each(svc.SPECIALTIES.map(s => s.id).filter(id => id !== 'cardiovascular-medicine'))('%s succeeds with follow-up windows', async specialty => {
    const result = await svc.submitAppointmentRequest({ request: request({ specialty }) }, NOW);
    expect(result).toMatchObject({ success: true, campus: 'Rochester, Minnesota', campusPhone: '507-538-3270' });
    expect(result.requestId).toMatch(/^MC-2026-\d{6}$/);
    expect(result.followUpWindows).toHaveLength(6);
    expect(result.followUpWindows[0]).toMatchObject({ id: '2026-11-13-morning', label: 'Friday, November 13, 8:00 – 10:00 a.m. CT' });
    expect(result.followUpWindows[3].id).toBe('2026-11-16-morning'); // skips the weekend
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('follow-up windows start the next campus-local business day', () => {
    const thursdayEveningCT = new Date('2026-11-13T05:30:00Z'); // Thu 23:30 CT, already Friday in UTC and ET
    expect(svc.buildFollowUpWindows({ campus: 'rochester' }, thursdayEveningCT).map(w => w.date)).toEqual(['2026-11-13', '2026-11-13', '2026-11-13', '2026-11-16', '2026-11-16', '2026-11-16']);
    expect(svc.buildFollowUpWindows({ campus: 'florida' }, thursdayEveningCT)[0].date).toBe('2026-11-16'); // Fri 00:30 ET
  });

  test('request numbers are never reused while a request is stored', async () => {
    const crypto = require('crypto');
    const first = await svc.submitAppointmentRequest({ request: request({ specialty: 'neurology' }) }, NOW);
    const repeat = Number(first.requestId.slice(-6));
    const spy = jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(repeat).mockReturnValueOnce((repeat + 1) % 1e6);
    try {
      const second = await svc.submitAppointmentRequest({ request: request({ specialty: 'oncology', patient: { ...request().patient, firstName: 'Sam' } }) }, NOW);
      expect(second.requestId).not.toBe(first.requestId);
      expect(svc.confirmFollowUp(first.requestId, first.followUpWindows[0].id).firstName).toBe('Jordan');
    } finally { spy.mockRestore(); }
  });

  test('self-pay, other campuses and caregiver requests succeed; follow-up confirmation is server-checked', async () => {
    const result = await svc.submitAppointmentRequest({ request: request({ specialty: 'dermatology', campus: 'florida', isPatient: false, requesterRelationship: 'Spouse', insurance: { type: 'self-pay' } }) }, NOW);
    expect(result.followUpWindows[0].label).toMatch(/ET$/);
    expect(() => svc.confirmFollowUp(result.requestId, 'bogus')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => svc.confirmFollowUp('MC-0000-000000', result.followUpWindows[0].id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(svc.confirmFollowUp(result.requestId, result.followUpWindows[1].id)).toMatchObject({ success: true, firstName: 'Jordan', followUp: result.followUpWindows[1] });
  });

  test.each([
    null, [], {}, request({ isPatient: 'yes' }), request({ isPatient: false }), request({ patient: null }),
    request({ patient: { ...request().patient, firstName: '' } }), request({ patient: { ...request().patient, dateOfBirth: '2099-01-01' } }),
    request({ patient: { ...request().patient, dateOfBirth: '12/04/1968' } }), request({ patient: { ...request().patient, dateOfBirth: '1968-02-30' } }), request({ patient: { ...request().patient, email: 'nope' } }),
    request({ patient: { ...request().patient, phone: '555-0142' } }), request({ specialty: 'cardiology' }), request({ specialty: '__proto__' }),
    request({ concern: 'short' }), request({ insurance: null }), request({ insurance: { type: 'insurance', carrier: 'Unknown', memberId: 'X123' } }),
    request({ insurance: { type: 'insurance', carrier: 'Medica', memberId: '' } }), request({ campus: 'london' }), request({ contactPreference: 'fax' }),
  ])('rejects invalid input before alerting: %j', async input => {
    await expect(svc.submitAppointmentRequest({ request: input }, NOW)).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'INVALID_APPOINTMENT_REQUEST' });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('planted triage failure and incident flow', () => {
  test('Cardiovascular Medicine produces one Sentry capture and an instant alert with an actionable PR prompt', async () => {
    await expect(svc.submitAppointmentRequest({ request: request(), devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' }, NOW)).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'callbackSlaHours')", status: 500, code: 'APPOINTMENT_REQUEST_FAILED', requestId: expect.stringMatching(/^MC-2026-/),
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({ tags: expect.objectContaining({ customer: svc.CUSTOMER, alert_path: 'instant' }) }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: svc.CUSTOMER, service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { specialty: 'cardiovascular-medicine', campus: 'rochester' } });
    expect(JSON.stringify(alert)).not.toMatch(/Jordan|Ellis|1968-04-12|XKM448120937|555-0142/);
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(isInstantPathEvent({ culprit: svc.CULPRIT, tags: [] })).toBe(true);
    expect(buildPrompt(alert)).toContain('8d8c2937');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('pull request against main; do not merge or deploy');
    expect(alert.promptAppendix).toContain('CV-NEWPT with a 24-hour callback SLA');
    const blocks = JSON.stringify(buildAlertBlocks(alert));
    expect(blocks).toContain('Mayo Clinic'); expect(blocks).toContain('callbackSlaHours');
  });

  test('alert delivery failures never replace the original error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.submitAppointmentRequest({ request: request() }, NOW)).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for Mayo Clinic appointment intake', expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
  let server, port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  function call(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  test('catalog lists public options, not the internal triage table', async () => {
    const res = await call('GET', '/api/8d8c2937/catalog');
    expect(res.status).toBe(200); expect(res.body.specialties).toHaveLength(7); expect(res.body.campuses).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/callbackSlaHours|NEWPT/);
  });
  test('submit returns 500 on the planted bug, 200 when healthy, 400 on invalid input; follow-up confirms', async () => {
    expect(await call('POST', '/api/8d8c2937/appointment-requests', { request: request(), devinUserId: 'route-user', devinOrgId: 'route-org' })).toMatchObject({ status: 500, body: { success: false, code: 'APPOINTMENT_REQUEST_FAILED', errorClass: 'TypeError', requestId: expect.stringMatching(/^MC-/) } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    const ok = await call('POST', '/api/8d8c2937/appointment-requests', { request: request({ specialty: 'dermatology' }) });
    expect(ok).toMatchObject({ status: 200, body: { success: true, specialty: 'Dermatology' } });
    expect(await call('POST', `/api/8d8c2937/appointment-requests/${ok.body.requestId}/follow-up`, { windowId: ok.body.followUpWindows[0].id })).toMatchObject({ status: 200, body: { success: true } });
    expect(await call('POST', '/api/8d8c2937/appointment-requests/unknown/follow-up', { windowId: 'x' })).toMatchObject({ status: 404, body: { code: 'REQUEST_NOT_FOUND' } });
    expect(await call('POST', '/api/8d8c2937/appointment-requests', { request: request({ campus: 'nowhere' }) })).toMatchObject({ status: 400, body: { code: 'INVALID_APPOINTMENT_REQUEST' } });
    expect(await call('POST', '/api/8d8c2937/appointment-requests')).toMatchObject({ status: 400 });
  });
});

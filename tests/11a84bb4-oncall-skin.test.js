jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS, skinRepo } = require('../app/services/oncall');
const {
  resetState, searchSessions, getSession, changeCapacity, STATE_TTL_MS,
} = require('../app/services/oncall-verticals/assessmentscheduling');
const SEED = require('../app/services/oncall-verticals/assessmentscheduling-seed.json');
const { getOncallSkin } = require('../config/oncall-skins');

const SLUG = '11a84bb4';
const TITLE = 'Northwind Scheduling';
const API = '/api/oncall/assessmentscheduling';

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  app.use('/api/oncall/assessmentscheduling', oncallVerticalRoutes.assessmentSchedulingBodyErrorHandler);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

beforeEach(() => resetState());

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('11a84bb4 Northwind Assessment Network scheduling-service skin', () => {
  test('is a native, Slack-routed assessmentscheduling skin with an auto session in SampleMvcWebApp', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      company: 'Northwind Assessment Network',
      vertical: 'assessmentscheduling',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/assessment-scheduling', '/northwind-scheduling'],
      page: { file: '11a84bb4.html', title: TITLE },
      alertCard: { service: 'scheduling-service', release: 'scheduling-service@1.4.0', team: 'scheduling-service-oncall' },
    });
    expect(skin.devinSession.auto).toBe(true);
    expect(skin.devinSession.repo).toEqual({ name: 'COG-GTM/SampleMvcWebApp', branch: 'assessment-delivery-demo' });
    expect(skinRepo(skin)).toEqual({
      name: 'COG-GTM/SampleMvcWebApp',
      branch: 'assessment-delivery-demo',
      url: 'https://github.com/COG-GTM/SampleMvcWebApp/tree/assessment-delivery-demo',
    });
    expect(skin.devinSession.promptAppendix).toContain('folder services/scheduling-service/');
    expect(skin.devinSession.promptAppendix).toContain('http://localhost:8090/app/admin/centers/BOS01');
    expect(skin.devinSession.promptAppendix).toContain('http://localhost:8090/app/admin/sessions/198');
    expect(skin.devinSession.promptAppendix).toContain('"New capacity 9 is below the accommodation floor 10"');
    expect(skin.devinSession.promptAppendix).toContain('Record that repro');
    expect(skin.devinSession.promptAppendix).toContain('mvn -B verify');
    expect(skin.devinSession.promptAppendix).toContain('scripts/run-scheduling-service.sh');
    expect(skin.devinSession.promptAppendix).toContain('docs/adr/0002-ported-rule-decisions.md');
    expect(skin.devinSession.promptAppendix).toContain('assessment-delivery-demo');
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();

    const scenario = ALERT_SCENARIOS.assessmentscheduling;
    expect(scenario).toMatchObject({
      apiPath: '/api/northwind-scheduling',
      oncallApiPath: API,
      service: 'scheduling-service',
      triggerWhen: { action: 'change-capacity' },
      alertOnStatus: [409],
      unlisted: true,
    });
    expect(skin.alertCard).toMatchObject({
      title: 'Capacity change rejections \u2014 scheduling-service PUT /api/v2/sessions/{sessionId}/capacity',
      metricQuery: 'sum:scheduling_service.capacity_change.rejected{service:scheduling-service,error:capacity_below_accommodation_floor}.as_count()',
    });
    expect(skin.alertCard.metricValue).toContain('HTTP 409 CAPACITY_BELOW_ACCOMMODATION_FLOOR');
    expect(skin.alertCard.symptom).toContain('BOS01 session #198 (MHL-PHT, capacity 23, 8 booked, 2 accommodation seats) 23 \u2192 9');
    expect(skin.alertCard.symptom).toContain('"New capacity 9 is below the accommodation floor 10"');
    expect(scenario.symptom).toContain('BOS01 session #198 (MHL-PHT) 23 \u2192 9');
    expect(JSON.stringify(skin)).not.toMatch(/41872|30 \u2192 24/);
    // Monitor-shaped only: nothing about how the floor is computed.
    const copy = JSON.stringify(scenario) + JSON.stringify(skin.alertCard) + skin.devinSession.promptAppendix;
    expect(copy).not.toMatch(/\.js|\.java|on top of|booked \+|accommodationCapacity|standard|non-ET|COMMITTED/i);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page with one disclaimer', async () => {
    const paths = [`/oncall/c/${SLUG}`, `/${SLUG}`, '/assessment-scheduling', '/northwind-scheduling'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("var API = '/api/northwind-scheduling'");
    expect(html).toContain('const apiPath = "/api/northwind-scheduling"');
    expect(html).toContain(`const oncallApiPath = "${API}"`);
    expect(html).toContain('const triggerWhen = {"action":"change-capacity"}');
    expect(html).toContain('const alertOnStatus = [409]');
    expect(html).toContain('var skinAlertDestination = "slack"');
    // The first session search must wait for the shim, which is injected after the page script.
    expect(html).toContain("document.addEventListener('DOMContentLoaded', start)");
    expect(html.indexOf("addEventListener('DOMContentLoaded', start)")).toBeLessThan(html.indexOf('window.fetch = function'));
    expect(html.match(/NOT A REAL ORGANIZATION/g)).toHaveLength(1);
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/${SLUG}/report`),
      fetch(`${baseUrl}/oncall/c/${SLUG}/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('page is a replica of the scheduling-service admin UI: header, routes, capacity editor, confirm modal and toast', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/${SLUG}`)).text();
    // Compiled Tailwind build of services/scheduling-service/frontend, plus the sonner toast styles.
    expect(html).toContain('.btn-primary{');
    expect(html).toContain('[data-sonner-toaster]');
    expect(html).toContain('<body class="bg-slate-50 text-slate-900 antialiased">');
    expect(html).toContain('bg-gradient-to-r from-brand-700 via-brand-600 to-indigo-600 shadow');
    expect(html).toContain('<span class="block text-xs text-brand-100">Test-center scheduling</span>');
    ['Find a session', 'My bookings', 'Center admin'].forEach((label) => expect(html).toContain(`>${label}</a>`));
    expect(html).toContain("var DEFAULT_ROUTE = '#/admin/centers/BOS01'");
    expect(html).toContain('/^\\/admin\\/centers\\/([^/]+)$/');
    expect(html).toContain('/^\\/admin\\/sessions\\/([^/]+)$/');
    expect(html).toContain("openModal(form, 'Change capacity?'");
    expect(html).toContain("Set capacity to ' + esc(next)");
    expect(html).toContain('No booked candidate is affected.');
    expect(html).toContain("e.code + ' (legacy ' + e.legacyCode + ')'");
    expect(html).toContain("action: 'change-capacity', sessionId: id, newCapacity: newCapacity, actor: 'admin-ui'");
    expect(html).toContain("var API = '/api/northwind-scheduling'");
    expect(html).not.toMatch(/41872|newCapacity" type="number"/);
  });

  test('seed is the real assessment-delivery-demo data, with BOS01 session 198 as the demo session', async () => {
    expect(SEED.centers).toHaveLength(20);
    expect(SEED.exams).toHaveLength(12);
    const res = await post(`${API}/sessions/detail`, { sessionId: 198 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 198,
      examCode: 'MHL-PHT',
      examTitle: 'Pharmacy Technician Certificate',
      centerCode: 'BOS01',
      centerName: 'Harborview Testing Centre',
      roomName: 'Room A',
      startsAt: '2026-12-03T09:00:00',
      capacity: 23,
      accommodationCapacity: 2,
      seatsAvailable: 15,
      status: 'OPEN',
      bookedSeats: 8,
      accommodationUsed: 0,
      waitlistCount: 0,
    });
    const ref = await (await post(`${API}/reference`, {})).json();
    expect(ref.centers.find((c) => c.centerCode === 'BOS01')).toMatchObject({ name: 'Harborview Testing Centre', city: 'Boston', region: 'NA-EAST' });
  });

  test('centre search matches the admin grid (from inclusive, to exclusive) and 404s unknown centres', async () => {
    const { sessions } = await (await post(`${API}/sessions/search`, { centerCode: 'BOS01', from: '2026-11-11' })).json();
    expect(sessions.map((s) => s.sessionId).slice(0, 5)).toEqual([153, 462, 191, 198, 208]);
    expect(sessions).toHaveLength(17);
    expect(sessions.reduce((t, s) => t + s.capacity, 0)).toBe(298);
    expect(sessions.reduce((t, s) => t + s.bookedSeats, 0)).toBe(116);
    expect(sessions.reduce((t, s) => t + s.waitlistCount, 0)).toBe(3);
    const day = await (await post(`${API}/sessions/search`, { centerCode: 'BOS01', from: '2026-12-03', to: '2026-12-08' })).json();
    expect(day.sessions.map((s) => s.sessionId)).toEqual([198]);
    const unknown = await post(`${API}/sessions/search`, { centerCode: 'XXX01' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('CENTER_NOT_FOUND');
  });

  test('waitlist returns the seeded candidates in position order', async () => {
    const res = await post(`${API}/sessions/waitlist`, { sessionId: 153 });
    const list = await res.json();
    expect(list).toHaveLength(3);
    expect(list.map((w) => w.position)).toEqual([1, 2, 3]);
    expect(list[0]).toMatchObject({ bookingId: 1603, candidateNumber: 'NW00000410', candidateName: 'Ruby Underwood' });
  });

  test('23 -> 9 on #198 is rejected with 409 CAPACITY_BELOW_ACCOMMODATION_FLOOR (legacyCode 50005)', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 198, newCapacity: 9, actor: 'admin-ui' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'CAPACITY_BELOW_ACCOMMODATION_FLOOR',
      message: 'New capacity 9 is below the accommodation floor 10',
      legacyCode: 50005,
    });
    expect(getSession({ sessionId: 198 }).capacity).toBe(23);
  });

  test('23 -> 10 on #198 (at the floor) succeeds without bumping anyone', async () => {
    const res = await post(`${API}/sessions/capacity`, { sessionId: 198, newCapacity: 10, actor: 'admin-ui' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bumpedBookingIds).toEqual([]);
    expect(body.session).toMatchObject({ sessionId: 198, capacity: 10, seatsAvailable: 2, bookedSeats: 8 });
  });

  test('reducing a session without accommodation seats below the seats held waitlists the newest bookings', () => {
    // #208 CTA-CLD3: capacity 11, 7 booked, no accommodation seats.
    const result = changeCapacity({ sessionId: 208, newCapacity: 5 });
    expect(result.session).toMatchObject({ capacity: 5, bookedSeats: 5, seatsAvailable: 0, waitlistCount: 2 });
    expect(result.bumpedBookingIds).toEqual([208006, 208007]);
  });

  test('booking a seat succeeds, joins the waitlist when full and validates input', async () => {
    const ok = await post(`${API}/bookings`, { sessionId: 198, candidateNumber: 'nw00000901', accommodationCode: 'ET25' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ status: 'BOOKED', sessionId: 198, candidateNumber: 'NW00000901', accommodationCode: 'ET25', seatsAvailable: 14 });
    const dup = await post(`${API}/bookings`, { sessionId: 198, candidateNumber: 'NW00000901' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).legacyCode).toBe(50002);
    const full = await post(`${API}/bookings`, { sessionId: 153, candidateNumber: 'NW00000902' });
    expect(await full.json()).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 4 });
    const bad = await post(`${API}/bookings`, { sessionId: 198, candidateNumber: 'ABC' });
    expect(bad.status).toBe(400);
    const mine = await (await post(`${API}/candidates/bookings`, { candidateNumber: 'NW00000901' })).json();
    expect(mine).toEqual([expect.objectContaining({ sessionId: 198, examCode: 'MHL-PHT', status: 'BOOKED' })]);
  });

  test('negative and non-integer capacities are 400 VALIDATION', async () => {
    for (const newCapacity of [-1, 2.5, 'abc', 501]) {
      const res = await post(`${API}/sessions/capacity`, { sessionId: 198, newCapacity });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('VALIDATION');
    }
  });

  test('state returns to the seed after the idle window', () => {
    const realNow = Date.now;
    try {
      changeCapacity({ sessionId: 198, newCapacity: 20 });
      expect(searchSessions({ centerCode: 'BOS01' }).sessions.find((s) => s.sessionId === 198).capacity).toBe(20);
      const later = realNow() + STATE_TTL_MS + 1000;
      Date.now = () => later;
      expect(getSession({ sessionId: 198 }).capacity).toBe(23);
    } finally {
      Date.now = realNow;
    }
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await fetch(`${baseUrl}${API}/sessions/capacity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"sessionId": 198, "newCapacity": ',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'BAD_REQUEST', message: 'Malformed JSON request body', legacyCode: null });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('unknown sessions are 404 SESSION_NOT_FOUND', async () => {
    for (const path of ['/sessions/capacity', '/sessions/detail', '/sessions/waitlist']) {
      const res = await post(`${API}${path}`, { sessionId: 99999, newCapacity: 20 });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('SESSION_NOT_FOUND');
    }
  });
});

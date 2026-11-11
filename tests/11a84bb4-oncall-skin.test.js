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
const { resetState, searchSessions, changeCapacity } = require('../app/services/oncall-verticals/assessmentscheduling');
const { getOncallSkin } = require('../config/oncall-skins');

const SLUG = '11a84bb4';
const TITLE = 'Session scheduling | Northwind Assessment Network';
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

async function findSession(sessionId, centerCode = 'BOS01') {
  const res = await post(`${API}/sessions/search`, { centerCode });
  const data = await res.json();
  return data.sessions.find((s) => s.sessionId === sessionId);
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
    expect(html).toContain('scheduling-service v1.4');
    // The first session search must wait for the shim, which is injected after the page script.
    expect(html).toContain("document.addEventListener('DOMContentLoaded', search)");
    expect(html.indexOf("addEventListener('DOMContentLoaded', search)")).toBeLessThan(html.indexOf('window.fetch = function'));
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

  test('session search lists capacity, accommodation seats, booked and derived seats available', async () => {
    const res = await post(`${API}/sessions/search`, { action: 'search-sessions', centerCode: 'BOS01' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.centre).toMatchObject({ code: 'BOS01', name: 'Harborview Testing Centre', city: 'Boston' });
    const demo = data.sessions.find((s) => s.sessionId === 41872);
    expect(demo).toMatchObject({
      centerCode: 'BOS01', examCode: 'CTA-SEC2', room: 'Room B', capacity: 30, accommodationCapacity: 4, booked: 22,
      accommodationUsed: 0, seatsAvailable: 8, waitlistCount: 0, note: '6 workstations out of service',
    });
    data.sessions.forEach((s) => expect(s.seatsAvailable).toBe(Math.max(0, s.capacity - s.booked)));

    const filtered = await (await post(`${API}/sessions/search`, { centerCode: 'BOS01', examCode: 'BCB-PM100' })).json();
    expect(filtered.sessions.length).toBeGreaterThan(0);
    filtered.sessions.forEach((s) => expect(s.examCode).toBe('BCB-PM100'));

    const names = await Promise.all(['NYC02', 'ATL01', 'DEN01'].map(async (code) => (await (await post(`${API}/sessions/search`, { centerCode: code })).json()).centre.name));
    expect(names).toEqual(['Midtown Assessment Suites', 'Peachtree Exam Centre', 'Front Range Exam Centre']);

    const unknown = await post(`${API}/sessions/search`, { centerCode: 'NW-CHI-01' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'CENTER_NOT_FOUND', legacyCode: null });
  });

  test('booking a seat succeeds and validates candidate numbers and accommodation codes', async () => {
    const res = await post(`${API}/bookings`, {
      action: 'book-seat', sessionId: 41873, candidateNumber: 'NW20481736', accommodationCode: 'ET25',
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.booking).toMatchObject({ sessionId: 41873, candidateNumber: 'NW20481736', accommodationCode: 'ET25', status: 'BOOKED' });
    expect(data.session).toMatchObject({ booked: 10, accommodationUsed: 2, seatsAvailable: 14 });

    const duplicate = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'NW20481736' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: 'DUPLICATE_BOOKING', legacyCode: 50002 });

    const noSeat = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'NW20481739', accommodationCode: 'ET50' });
    expect(noSeat.status).toBe(409);
    expect(await noSeat.json()).toMatchObject({ error: 'NO_ACCOMMODATION_SEAT', legacyCode: 50003 });

    const badNumber = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'PSV1234567' });
    expect(badNumber.status).toBe(400);
    expect((await badNumber.json()).error).toBe('VALIDATION');
    const badCode = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'NW20481737', accommodationCode: 'XX' });
    expect(badCode.status).toBe(400);

    const full = await post(`${API}/bookings`, { sessionId: 41875, candidateNumber: 'NW20481738' });
    expect(full.status).toBe(201);
    expect((await full.json()).booking).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });
  });

  test('30 -> 24 on #41872 is rejected with 409 CAPACITY_BELOW_ACCOMMODATION_FLOOR (legacyCode 50005)', async () => {
    const res = await post(`${API}/sessions/capacity`, {
      action: 'change-capacity', sessionId: 41872, newCapacity: 24, actor: 'jordan.ellis@BOS01', reason: '6 workstations out of service',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'CAPACITY_BELOW_ACCOMMODATION_FLOOR',
      message: 'New capacity 24 is below the accommodation floor 26',
      legacyCode: 50005,
    });
    expect(await findSession(41872)).toMatchObject({ capacity: 30, seatsAvailable: 8, waitlistCount: 0 });
  });

  test('30 -> 27 on #41872 (above the 26 floor) succeeds without bumping anyone', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41872, newCapacity: 27 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      previousCapacity: 30,
      session: { sessionId: 41872, capacity: 27, booked: 22, seatsAvailable: 5 },
      bumpedBookingIds: [],
    });
  });

  test('increasing capacity succeeds and queues the outbox event', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41872, newCapacity: 34 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      previousCapacity: 30,
      session: { sessionId: 41872, capacity: 34, seatsAvailable: 12 },
      bumpedBookingIds: [],
      outbox: { event: 'SessionCapacityChanged', status: 'QUEUED' },
    });
  });

  test('reducing a session without accommodation seats below the seats held succeeds and waitlists the newest bookings', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41871, newCapacity: 12 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bumpedBookingIds).toEqual([41871013, 41871014, 41871015]);
    expect(data.session).toMatchObject({ sessionId: 41871, capacity: 12, accommodationCapacity: 0, booked: 12, seatsAvailable: 0, waitlistCount: 3 });

    const smaller = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41871, newCapacity: 0 });
    expect(smaller.status).toBe(200);
    expect((await smaller.json()).bumpedBookingIds).toHaveLength(12);
  });

  test('negative capacity is 400 VALIDATION', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41871, newCapacity: -1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'VALIDATION', message: 'newCapacity must be zero or more', legacyCode: 50005 });
  });

  test('unchanged demo state is reseeded on a new day so the demo session stays searchable', () => {
    const day0 = new Date('2026-11-11T12:00:00Z');
    const day3 = new Date('2026-11-14T12:00:00Z');
    const demo = (now) => searchSessions({ centerCode: 'BOS01' }, now).sessions.find((s) => s.sessionId === 41872);
    expect(demo(day0).date).toBe('2026-11-13');
    expect(demo(day3).date).toBe('2026-11-16');
  });

  test('a recent capacity change is kept within the idle window', () => {
    changeCapacity({ sessionId: 41872, newCapacity: 34 });
    expect(searchSessions({ centerCode: 'BOS01' }).sessions.find((s) => s.sessionId === 41872).capacity).toBe(34);
  });

  test.each([
    ['boolean newCapacity', { sessionId: 41872, newCapacity: true }],
    ['array newCapacity', { sessionId: 41872, newCapacity: [25] }],
    ['trailing garbage newCapacity', { sessionId: 41872, newCapacity: '25abc' }],
    ['fractional newCapacity', { sessionId: 41872, newCapacity: 25.5 }],
    ['empty newCapacity', { sessionId: 41872, newCapacity: '' }],
    ['legacy capacity field only', { sessionId: 41872, capacity: 34 }],
    ['boolean sessionId', { sessionId: true, newCapacity: 25 }],
    ['array sessionId', { sessionId: [41872], newCapacity: 25 }],
    ['trailing garbage sessionId', { sessionId: '41872abc', newCapacity: 25 }],
    ['fractional sessionId', { sessionId: 41872.5, newCapacity: 25 }],
  ])('rejects %s with 400 VALIDATION', async (_label, body) => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', ...body });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('VALIDATION');
    expect(await findSession(41872)).toMatchObject({ capacity: 30 });
  });

  test('rejects a non-integer sessionId on bookings with 400', async () => {
    const res = await post(`${API}/bookings`, { sessionId: [41873], candidateNumber: 'NW20481736' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('VALIDATION');
  });

  test('accepts digit-only string ids and capacities', async () => {
    const res = await post(`${API}/sessions/capacity`, { sessionId: '41872', newCapacity: '34' });
    expect(res.status).toBe(200);
    expect((await res.json()).session.capacity).toBe(34);
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await fetch(`${baseUrl}${API}/sessions/capacity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"sessionId": 41872, "newCapacity": ',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'BAD_REQUEST', message: 'Malformed JSON request body', legacyCode: null });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('page shows the v2 contract, BOS01 centres and the waitlist outcome', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/${SLUG}`)).text();
    expect(html).toContain('body { padding-bottom: 112px; }');
    expect(html).toContain('value="6 workstations out of service"');
    expect(html).toContain('<option value="BOS01" selected>BOS01 · Harborview Testing Centre</option>');
    expect(html).toContain('GET /api/v2/centers/{centerCode}/sessions');
    expect(html).toContain('POST /api/v2/bookings');
    expect(html).toContain('PUT /api/v2/sessions/{sessionId}/capacity');
    expect(html).toContain('newCapacity: capacity');
    expect(html).toContain('<input id="newCapacity" type="number" min="0" max="200"');
    expect(html).toContain("' moved to waitlist.'");
    expect(html).not.toMatch(/COMMITTED|\/api\/v1\/|NW-CHI-01/);
  });

  test('unknown sessions are 404 SESSION_NOT_FOUND', async () => {
    const unknown = await post(`${API}/sessions/capacity`, { sessionId: 99999, newCapacity: 20 });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('SESSION_NOT_FOUND');
  });
});

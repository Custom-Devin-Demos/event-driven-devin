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
const { resetState } = require('../app/services/oncall-verticals/assessmentscheduling');
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

async function findSession(sessionId, centerCode = 'NW-CHI-01') {
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
    expect(skin.devinSession.promptAppendix).toContain('scheduling-service/');
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
    // Monitor-shaped only: nothing about how the floor is computed.
    const copy = JSON.stringify(scenario) + JSON.stringify(skin.alertCard) + skin.devinSession.promptAppendix;
    expect(copy).not.toMatch(/\.js|\.java|floor|on top of|booked \+|accommodationCapacity/i);
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
    const res = await post(`${API}/sessions/search`, { action: 'search-sessions', centerCode: 'NW-CHI-01' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.centre).toMatchObject({ code: 'NW-CHI-01', name: 'Chicago Loop' });
    const demo = data.sessions.find((s) => s.sessionId === 41872);
    expect(demo).toMatchObject({
      examCode: 'NWA-NET-310', room: 'Room B', capacity: 30, accommodationCapacity: 4, booked: 22, seatsAvailable: 8,
      note: 'Room B: 6 workstations out of service',
    });
    data.sessions.forEach((s) => expect(s.seatsAvailable).toBe(Math.max(0, s.capacity - s.booked)));

    const filtered = await (await post(`${API}/sessions/search`, { centerCode: 'NW-CHI-01', examCode: 'NWA-PM-210' })).json();
    expect(filtered.sessions.length).toBeGreaterThan(0);
    filtered.sessions.forEach((s) => expect(s.examCode).toBe('NWA-PM-210'));

    const unknown = await post(`${API}/sessions/search`, { centerCode: 'NW-XXX-01' });
    expect(unknown.status).toBe(404);
  });

  test('booking a seat succeeds and validates candidate numbers and accommodation codes', async () => {
    const res = await post(`${API}/bookings`, {
      action: 'book-seat', sessionId: 41873, candidateNumber: 'NW20481736', accommodationCode: 'ET25',
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.booking).toMatchObject({ sessionId: 41873, candidateNumber: 'NW20481736', accommodationCode: 'ET25', status: 'BOOKED' });
    expect(data.session).toMatchObject({ booked: 10, accommodationBooked: 2, seatsAvailable: 14 });

    const duplicate = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'NW20481736' });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe('DUPLICATE_BOOKING');

    const badNumber = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'PSV1234567' });
    expect(badNumber.status).toBe(400);
    const badCode = await post(`${API}/bookings`, { sessionId: 41873, candidateNumber: 'NW20481737', accommodationCode: 'XX' });
    expect(badCode.status).toBe(400);

    const full = await post(`${API}/bookings`, { sessionId: 41875, candidateNumber: 'NW20481738' });
    expect(full.status).toBe(201);
    expect((await full.json()).booking.status).toBe('WAITLISTED');
  });

  test('reducing capacity on a session with accommodation seats is rejected with 409 CAPACITY_BELOW_COMMITTED', async () => {
    const res = await post(`${API}/sessions/capacity`, {
      action: 'change-capacity', sessionId: 41872, capacity: 24, reason: 'Room B: 6 workstations out of service',
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data).toMatchObject({
      success: false,
      code: 'CAPACITY_BELOW_COMMITTED',
      error: 'Capacity 24 is below committed seats (26) for session 41872',
    });
    expect(await findSession(41872)).toMatchObject({ capacity: 30, seatsAvailable: 8 });
  });

  test('increasing capacity succeeds and queues the outbox event', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41872, capacity: 34 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      success: true,
      previousCapacity: 30,
      session: { sessionId: 41872, capacity: 34, seatsAvailable: 12 },
      outbox: { event: 'SessionCapacityChanged', status: 'QUEUED' },
    });
  });

  test('reducing capacity on a session without accommodation seats succeeds', async () => {
    const res = await post(`${API}/sessions/capacity`, { action: 'change-capacity', sessionId: 41871, capacity: 20 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toMatchObject({ sessionId: 41871, capacity: 20, accommodationCapacity: 0, booked: 15, seatsAvailable: 5 });
  });

  test('invalid capacity requests are 400 and unknown sessions 404', async () => {
    const [bad, unknown] = await Promise.all([
      post(`${API}/sessions/capacity`, { sessionId: 41871, capacity: 'lots' }),
      post(`${API}/sessions/capacity`, { sessionId: 99999, capacity: 20 }),
    ]);
    expect(bad.status).toBe(400);
    expect(unknown.status).toBe(404);
  });
});

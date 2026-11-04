jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

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

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function firstSlot(providerId, locationId = 'LOC-TPA-01') {
  const res = await post('/api/oncall/patientscheduling/availability', { providerId, locationId });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.days).toHaveLength(5);
  return data.days[0].slots[0].id;
}

const TITLE = 'Book an appointment | Nextech';

describe('56ddb972 patient scheduling on-call skin', () => {
  test('is a native, unlisted patientscheduling skin without report or incident surfaces', () => {
    const skin = getOncallSkin('56ddb972');
    expect(skin).toMatchObject({ vertical: 'patientscheduling', oncallOnly: true, alertDestination: 'slack', page: { file: '56ddb972.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A [A-Z]+ SITE/);
    expect(Object.keys(skin.theme)).toEqual(['--accent', '--ink', '--surface', '--chrome-bg', '--chrome-text']);
    const scenario = ALERT_SCENARIOS.patientscheduling;
    expect(scenario).toMatchObject({
      apiPath: '/api/patient-scheduling',
      oncallApiPath: '/api/oncall/patientscheduling',
      triggerWhen: { action: 'book-appointment', providerId: 'PRV-1042' },
      unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|SCHEDULE_TEMPLATES|scheduleId|SCH-/);
  });

  test('skin URL serves the shimmed page and unknown slugs 404', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/56ddb972`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/patient-scheduling/appointments'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/patientscheduling"');
    expect(html).toContain('const triggerWhen = {"action":"book-appointment","providerId":"PRV-1042"}');
    expect(html).not.toContain('class="back-link"');
    expect((await fetch(`${baseUrl}/oncall/c/56ddb973`)).status).toBe(404);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/56ddb972/report`),
      fetch(`${baseUrl}/oncall/c/56ddb972/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Book appointment fails with a 500 for an open Dr. Ruiz time', async () => {
    const slotId = await firstSlot('PRV-1042');
    const res = await post('/api/oncall/patientscheduling/appointments', {
      providerId: 'PRV-1042', locationId: 'LOC-TPA-01', visitType: 'facial-consult', slotId,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'BOOKING_FAILED' });
    expect(body.error).not.toMatch(/undefined|TypeError|visitTypes/);
  });

  test.each(['PRV-1077', 'PRV-2015'])('Book appointment succeeds for %s', async (providerId) => {
    const slotId = await firstSlot(providerId, 'LOC-STP-02');
    const res = await post('/api/oncall/patientscheduling/appointments', {
      providerId, locationId: 'LOC-STP-02', visitType: 'facial-consult', slotId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, visitType: 'Facial rejuvenation consultation', location: 'St. Petersburg · Downtown' });
  });

  test('invalid bookings return 400', async () => {
    const slotId = await firstSlot('PRV-1077');
    const cases = [
      { providerId: 'PRV-9999', locationId: 'LOC-TPA-01', visitType: 'facial-consult', slotId },
      { providerId: 'PRV-1077', locationId: 'LOC-TPA-01', visitType: 'facial-consult', slotId: 'PRV-2015-20000101-0900' },
      { providerId: 'PRV-1077', locationId: 'LOC-TPA-01', visitType: 'injectables-consult', slotId },
    ];
    const statuses = await Promise.all(cases.map((c) => post('/api/oncall/patientscheduling/appointments', c).then((r) => r.status)));
    expect(statuses).toEqual([400, 400, 400]);
  });
});

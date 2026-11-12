jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { FIELD_TICKETS } = require('../app/services/oncall-verticals/fieldticket');

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

const PUBLIC = path.join(__dirname, '../app/public');
const TITLE = 'Field tickets | myHalliburton';
const APPROVAL = {
  ticketNumber: 'FT-4471093', approverName: 'Karen Alvarez', approverTitle: 'Completions Superintendent',
  poNumber: 'po-778214', afeNumber: 'AFE-26-0419', comments: '', acceptTerms: true,
};
const approve = (overrides) => fetch(`${baseUrl}/api/oncall/fieldticket/approve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...APPROVAL, ...overrides }),
});

describe('d4323ff8 myHalliburton field ticket approval on-call skin', () => {
  test('is a native, unlisted fieldticket skin alerting to Slack only on a failed approval', () => {
    const skin = getOncallSkin('d4323ff8');
    expect(skin).toMatchObject({
      company: 'Halliburton', vertical: 'fieldticket', oncallOnly: true, alertDestination: 'slack',
      paths: ['/myhalliburton', '/halliburton-field-tickets'], page: { file: 'd4323ff8.html', title: TITLE },
    });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A HALLIBURTON SITE/);
    expect(skin.alertCard).toMatchObject({
      title: '5xx rate \u2014 myHalliburton field ticket: Approve', release: 'commerce-central@2026.11.2', team: 'field-ticket-oncall',
    });
    expect(skin.devinSession.promptAppendix).toContain('cc @Travis Mendez (field-ticket-oncall)');
    const scenario = ALERT_SCENARIOS.fieldticket;
    expect(scenario).toMatchObject({
      page: 'd4323ff8.html', apiPath: '/api/d4323ff8/field-tickets/approve', oncallApiPath: '/api/oncall/fieldticket/approve',
      alertOnStatus: [500], unlisted: true,
    });
    expect(scenario.triggerWhen).toBeUndefined();
    expect(scenario.metricQuery).toContain('service:checkout-api');
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|APPROVAL_ROUTING|PE-EF/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page with self-hosted assets', async () => {
    const paths = ['/oncall/c/d4323ff8', '/d4323ff8', '/myhalliburton', '/halliburton-field-tickets'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("var API = '/api/d4323ff8/field-tickets/approve'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/fieldticket/approve"');
    expect(html).toContain('const alertOnStatus = [500]');
    expect(html).toContain('NOT ACTUALLY A HALLIBURTON SITE');
    expect(html).toContain('Approve &amp; e-sign');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:|<iframe|halliburton\.com|bfldr|brandfolder/);
    const css = fs.readFileSync(path.join(PUBLIC, 'verticals/d4323ff8/myhal.css'), 'utf8');
    const assets = [...new Set([
      ...(html.match(/\/verticals\/d4323ff8\/[^"')\s&]+/g) || []),
      ...[...css.matchAll(/url\(([^)]+)\)/g)].map((m) => `/verticals/d4323ff8/${m[1]}`),
    ])];
    expect(assets.length).toBeGreaterThanOrEqual(7);
    expect(assets.filter((a) => !fs.existsSync(path.join(PUBLIC, a)))).toEqual([]);
  });

  test('the page lists exactly the backend field tickets with matching line items', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/d4323ff8`)).text();
    const json = html.slice(html.indexOf('>', html.indexOf('id="ticket-data"')) + 1, html.indexOf('</script>', html.indexOf('id="ticket-data"')));
    const tickets = JSON.parse(json.replace(/<\\\//g, '</'));
    expect(Object.keys(tickets)).toEqual(Object.keys(FIELD_TICKETS));
    Object.entries(tickets).forEach(([id, t]) => {
      expect(t.lines).toEqual(FIELD_TICKETS[id].lines);
      expect(t.well).toBe(FIELD_TICKETS[id].well);
    });
    expect(Object.keys(tickets)[0]).toBe('FT-4471093');
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/d4323ff8/report`),
      fetch(`${baseUrl}/oncall/c/d4323ff8/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('approving ZEUS electric frac ticket FT-4471093 fails with a 500 TypeError', async () => {
    const res = await approve();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      success: false, errorClass: 'TypeError', code: 'FIELD_TICKET_APPROVAL_FAILED',
      error: "We couldn't approve this field ticket. Please try again later.",
    });
  });

  test.each([
    ['FT-4470881', 'Cementing', 'inv-cementing', 67375],
    ['FT-4470612', 'Wireline & Perforating', 'inv-wireline', 97970],
    ['FT-4469954', 'Baroid', 'inv-baroid', 86700],
  ])('approving %s posts to %s invoicing', async (ticketNumber, psl, invoiceQueue, total) => {
    const res = await approve({ ticketNumber });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      success: true, ticketNumber, poNumber: 'PO-778214', currency: 'USD', total,
      routing: { psl, invoiceQueue, invoiceHours: 24 },
    });
    expect(data.approvalNumber).toMatch(/^APR-\d{6}-\d{5}$/);
  });

  test.each([
    [{ ticketNumber: '' }, 'ticketNumber'],
    [{ ticketNumber: 'FT-0000000' }, 'ticketNumber'],
    [{ approverName: '  ' }, 'approverName'],
    [{ poNumber: '' }, 'poNumber'],
    [{ acceptTerms: false }, 'acceptTerms'],
  ])('invalid approval %j returns 400 for %s', async (overrides, field) => {
    const res = await approve(overrides);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_REQUEST', field });
  });
});

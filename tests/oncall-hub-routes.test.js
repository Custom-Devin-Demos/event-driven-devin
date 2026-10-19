const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

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
  server.close(() => {
    stopGateway().then(() => done());
  });
});

describe('on-call hub routes', () => {
  test('/oncall serves the hub page and /oncall/branded is gone', async () => {
    const stock = await fetch(`${baseUrl}/oncall`);
    expect(stock.status).toBe(200);
    expect(stock.headers.get('content-type')).toMatch(/text\/html/);

    const branded = await fetch(`${baseUrl}/oncall/branded`);
    expect(branded.status).toBe(404);
  });

  test('the healthcare page lists grouped scenarios and defaults its picker to Teams', async () => {
    const [pageResponse, groupedResponse, defaultResponse] = await Promise.all([
      fetch(`${baseUrl}/oncall/healthcare`),
      fetch(`${baseUrl}/api/oncall/scenarios?group=healthcare`),
      fetch(`${baseUrl}/api/oncall/scenarios`),
    ]);
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    expect(html).toContain('<title>Devin On-Call | Healthcare</title>');
    expect(html).toContain('<h1>Healthcare on-call demos</h1>');
    expect(html).toContain('Alert cards use Splunk searches and Dynatrace problems.');
    expect(html).toContain('/api/oncall/scenarios?group=healthcare');
    expect(html).toContain("defaultValue: 'teams'");
    expect(html).toContain('No healthcare demos are available yet.');
    expect(html).not.toContain('SEV-1 demo incident');

    const { scenarios: grouped } = await groupedResponse.json();
    const pbm = grouped.find((scenario) => scenario.id === 'pbm');
    expect(pbm).toMatchObject({
      group: 'healthcare',
      summary: 'Submit a pharmacy claim. It hangs ~8s, then returns a 504.',
    });
    const { scenarios: defaults } = await defaultResponse.json();
    expect(defaults.map((scenario) => scenario.id)).not.toContain('pbm');
    expect(defaults.find((scenario) => scenario.id === 'banking')).toMatchObject({ group: null, summary: null });
    expect(Object.keys(ALERT_SCENARIOS)).not.toContain('healthcare');
  });

  test('scenario oncallOnly pages are shimmed at both /oncall/pbm and /pbm', async () => {
    const [oncallResponse, directResponse] = await Promise.all([
      fetch(`${baseUrl}/oncall/pbm`),
      fetch(`${baseUrl}/pbm`),
    ]);
    expect(oncallResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    const html = await oncallResponse.text();
    expect(await directResponse.text()).toEqual(html);
    expect(html).toContain("fetch('/api/pbm/claim'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/pbm/claim"');
    expect(html).toContain('var scenarioAlertDestination = "teams"');
    expect(html).toContain("localStorage.getItem('alertDestinationExplicit') !== '1'");
  });

  test('toy SEV-1 incident routes are gone', async () => {
    const [consolePage, declare, kinds, state] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/a2088cb4/incident`),
      fetch(`${baseUrl}/api/oncall/incident`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'licensing-latency', skin: 'a2088cb4' }),
      }),
      fetch(`${baseUrl}/api/oncall/incident/kinds`),
      fetch(`${baseUrl}/api/oncall/incident/state`),
    ]);
    expect([consolePage.status, declare.status, kinds.status, state.status]).toEqual([404, 404, 404, 404]);
  });

  test('skinned pages no longer declare SEV-1 incidents from the browser', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'a2088cb4.html'), 'utf8');
    expect(page).not.toContain('/api/oncall/incident');
  });

  test('an oncallOnly native page is served shimmed at its direct slug too', async () => {
    const [direct, skinned] = await Promise.all([
      fetch(`${baseUrl}/63dbb52f`),
      fetch(`${baseUrl}/oncall/c/63dbb52f`),
    ]);
    expect(direct.status).toBe(200);
    const directHtml = await direct.text();
    expect(directHtml).toEqual(await skinned.text());
    expect(directHtml).toContain('/api/oncall/marketplace/cart');
  });

  test('the Nordstrom sweater uses the apparel endpoint without changing the shoe skin', async () => {
    const [direct, skinned, shoe] = await Promise.all([
      fetch(`${baseUrl}/0d1ff688`),
      fetch(`${baseUrl}/oncall/c/0d1ff688`),
      fetch(`${baseUrl}/oncall/c/4b663efb`),
    ]);
    expect(direct.status).toBe(200);
    expect(shoe.status).toBe(200);
    const directHtml = await direct.text();
    expect(directHtml).toEqual(await skinned.text());
    expect(directHtml).toContain('/api/oncall/apparel/bag');
    expect(await shoe.text()).toContain('/api/oncall/marketplace/cart');
  });

  test('the sporting goods skin reroutes checkout while the legacy /1b17e823 page stays unshimmed', async () => {
    const [skinned, legacy] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/b31d1347`),
      fetch(`${baseUrl}/1b17e823`),
    ]);
    expect(skinned.status).toBe(200);
    const html = await skinned.text();
    expect(html).toContain('/api/oncall/sportinggoods/checkout');
    expect(html).not.toMatch(/FLX|Foot Locker/);
    expect(html).toContain('{"fulfillment":"pickup"}');
    expect(html).toContain('var initialClick = ".opt[data-f=\\"pickup\\"]"');
    if (legacy.status === 200) expect(await legacy.text()).not.toContain('/api/oncall/sportinggoods/checkout');
  });

  test('the Coppel skin reroutes checkout in Spanish with the ribbon docked left, while /coppel stays unshimmed', async () => {
    const [skinned, friendly, legacy, other] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/04eac4a1`),
      fetch(`${baseUrl}/coppel-oncall`),
      fetch(`${baseUrl}/coppel`),
      fetch(`${baseUrl}/oncall/c/b31d1347`),
    ]);
    expect(skinned.status).toBe(200);
    expect(friendly.status).toBe(200);
    const html = await skinned.text();
    expect(await friendly.text()).toEqual(html);
    expect(html).toContain('/api/oncall/clickcollect/checkout');
    expect(html).toContain('Demo de Devin On-Call');
    expect(html).toMatch(/id="oncall-ribbon" style="[^"]*bottom:16px;left:16px;/);
    expect(html).toMatch(/id="oncall-dot"[^>]*bottom:16px;left:16px;/);
    expect(html).toContain('body:has(.toast.show) #oncall-ribbon, body:has(.toast.show) #oncall-dot { visibility: hidden !important; }');
    const otherHtml = await other.text();
    expect(otherHtml).toMatch(/id="oncall-ribbon" style="[^"]*bottom:16px;right:16px;/);
    expect(otherHtml).not.toContain('body:has(');
    if (legacy.status === 200) expect(await legacy.text()).not.toContain('oncall-ribbon');
  });

  test('the Egencia skin is served shimmed at its slug, friendly aliases and direct page URL, forcing Slack', async () => {
    const [skinned, alias, friendly, direct] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/e7a1c4d9`),
      fetch(`${baseUrl}/oncall/c/egencia`),
      fetch(`${baseUrl}/egencia-oncall`),
      fetch(`${baseUrl}/e7a1c4d9`),
    ]);
    expect([skinned.status, alias.status, friendly.status, direct.status]).toEqual([200, 200, 200, 200]);
    const html = await skinned.text();
    expect(await alias.text()).toEqual(html);
    expect(await friendly.text()).toEqual(html);
    expect(await direct.text()).toEqual(html);
    expect(html).toContain('<title>Trips | Egencia</title>');
    expect(html).toContain('const apiPath = "/api/egencia/rebook"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/rebooking/rebook"');
    expect(html).toContain('var skinAlertDestination = "slack"');
    expect(html).toMatch(/id="oncall-ribbon" style="[^"]*bottom:16px;left:16px;/);
    expect(html).toContain('const triggerWhen = {"action":"rebook"}');
    expect(html).toContain('Flight cancelled \u2014 rebooking options');
    const legacy = await fetch(`${baseUrl}/api/egencia/rebook`, { method: 'POST' });
    expect(legacy.status).toBe(404);
  });

  test('the store-pickup skin reroutes checkout and keeps the legacy page unshimmed', async () => {
    const [skinned, friendly, legacy, report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/d36c67bf`),
      fetch(`${baseUrl}/gap-oncall`),
      fetch(`${baseUrl}/gap`),
      fetch(`${baseUrl}/oncall/c/d36c67bf/report`),
      fetch(`${baseUrl}/oncall/c/d36c67bf/incident`),
    ]);
    expect([skinned.status, friendly.status, report.status, incident.status]).toEqual([200, 200, 404, 404]);
    const html = await skinned.text();
    expect(await friendly.text()).toEqual(html);
    expect(html).toContain('const oncallApiPath = "/api/oncall/storepickup/checkout"');
    expect(html).toContain('const triggerWhen = {"fulfillment":"pickup"}');
    expect(html).toContain('var skinAlertDestination = "slack"');
    expect(html).toMatch(/id="oncall-ribbon" style="[^"]*bottom:16px;left:16px;/);
    expect(html).toContain('NOT ACTUALLY A GAP SITE');
    if (legacy.status === 200) expect(await legacy.text()).not.toContain('oncall-ribbon');
  });

  test('store-pickup route accepts ship orders and rejects missing carts', async () => {
    const ship = await fetch(`${baseUrl}/api/oncall/storepickup/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sku: 'GAP-441020', qty: 1 }], fulfillment: 'ship' }),
    });
    expect(ship.status).toBe(200);
    expect(await ship.json()).toMatchObject({ success: true, fulfillment: 'ship', holds: [] });

    const invalid = await fetch(`${baseUrl}/api/oncall/storepickup/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ success: false, code: 'INVALID_CART' });
  });

  test('pickup route returns the store reservation timeout', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/storepickup/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sku: 'GAP-441020', qty: 1 }], fulfillment: 'pickup', storeNumber: '0412' }),
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Your order timed out while reserving items at your store. Please try again in a few minutes.',
      errorClass: 'GatewayTimeout',
      code: 'STORE_HOLD_TIMEOUT',
    });
  }, 15000);

  test('the a9a14d80 skin is served natively shimmed at its slug, forcing Slack, and opts out of report/incident', async () => {
    const [skinned, direct, report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/a9a14d80`),
      fetch(`${baseUrl}/a9a14d80`),
      fetch(`${baseUrl}/oncall/c/a9a14d80/report`),
      fetch(`${baseUrl}/oncall/c/a9a14d80/incident`),
    ]);
    expect(skinned.status).toBe(200);
    expect([report.status, incident.status]).toEqual([404, 404]);
    const html = await skinned.text();
    if (direct.status === 200) expect(await direct.text()).toEqual(html);
    expect(html).toContain('<title>Environments | PingOne</title>');
    expect(html).toContain('NOT ACTUALLY A PING IDENTITY SITE');
    expect(html).toContain('const apiPath = "/api/identity-console"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/identity"');
    expect(html).toContain('const triggerWhen = {"action":"create-environment"}');
    expect(html).toContain('var skinAlertDestination = "slack"');
    expect(html).toMatch(/id="oncall-ribbon" style="[^"]*bottom:16px;left:16px;/);
    expect(html).not.toContain('All Demos');
    const legacyApi = await fetch(`${baseUrl}/api/identity-console/environments`, { method: 'POST' });
    expect(legacyApi.status).toBe(404);
  });

  test('the GSK vaccine page uses the vaccines endpoint without changing the banking skins', async () => {
    const [direct, skinned, bank] = await Promise.all([
      fetch(`${baseUrl}/fe4f39ba`),
      fetch(`${baseUrl}/oncall/c/fe4f39ba`),
      fetch(`${baseUrl}/oncall/c/cb84fd21`),
    ]);
    expect(direct.status).toBe(200);
    expect(bank.status).toBe(200);
    const directHtml = await direct.text();
    expect(directHtml).toEqual(await skinned.text());
    expect(directHtml).toContain('/api/oncall/vaccines/order');
    expect(directHtml).not.toContain('/api/oncall/banking/transfer');
    expect(await bank.text()).toContain('/api/oncall/banking/transfer');
  });

  test('the shim sends the per-user alert destination and keeps a Teams fallback notice open', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/63dbb52f`)).text();
    expect(html).toContain("localStorage.getItem('alertDestination')");
    expect(html).toContain("alertDestination: alertDestination,");
    expect(html).not.toContain('teamsWebhookUrl');
    expect(html).toMatch(/if \(d\.teamsFailed\)[^\n]*went to Slack/);
    expect(html).toContain("if (d.ok && !d.teamsFailed) scheduleCollapse();");
    expect(html).toContain("else if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }");
  });
});

test('a skin alertDestination overrides the presenter\'s saved choice', async () => {
  const [slack, teams] = await Promise.all([
    fetch(`${baseUrl}/oncall/c/99defdc4`).then((r) => r.text()),
    fetch(`${baseUrl}/oncall/c/39080a2a`).then((r) => r.text()),
  ]);
  expect(slack).toContain('var skinAlertDestination = "slack";');
  expect(teams).toContain('var skinAlertDestination = "teams";');
  expect(slack).toContain("var alertDestination = skinAlertDestination || (");
  expect(slack).toContain("localStorage.getItem('alertDestinationExplicit') !== '1' && scenarioAlertDestination");
});

describe('on-call hub page contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'oncall.html'), 'utf8');

  test('hub keeps the shared on-call mechanics', () => {
    expect(html).toContain('href="https://coggtm.slack.com/archives/C0BVC5WS88G"');
    expect(html).not.toContain('/oncall/report');
  });
});

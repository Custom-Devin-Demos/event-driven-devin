const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const oncallRoutes = require('../app/routes/oncall');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('on-call hub routes', () => {
  test('/oncall serves the hub page and /oncall/branded is gone', async () => {
    const stock = await fetch(`${baseUrl}/oncall`);
    expect(stock.status).toBe(200);
    expect(stock.headers.get('content-type')).toMatch(/text\/html/);

    const branded = await fetch(`${baseUrl}/oncall/branded`);
    expect(branded.status).toBe(404);
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

  test('the Egencia skin is served shimmed at its slug, friendly aliases and direct page URL, forcing Teams', async () => {
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
    expect(html).toContain('var skinAlertDestination = "teams"');
    expect(html).toContain('const triggerWhen = {"action":"rebook"}');
    expect(html).toContain('Flight cancelled \u2014 rebooking options');
    const legacy = await fetch(`${baseUrl}/api/egencia/rebook`, { method: 'POST' });
    expect(legacy.status).toBe(404);
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
  expect(slack).toContain("var alertDestination = skinAlertDestination || (localStorage.getItem('alertDestination')");
});

describe('on-call hub page contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'oncall.html'), 'utf8');

  test('hub keeps the shared on-call mechanics', () => {
    expect(html).toContain('href="https://coggtm.slack.com/archives/C0BVC5WS88G"');
    expect(html).not.toContain('/oncall/report');
  });
});

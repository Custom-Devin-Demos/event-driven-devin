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

describe('on-call hub page contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'oncall.html'), 'utf8');

  test('hub keeps the shared on-call mechanics', () => {
    for (const marker of ['href="https://coggtm.slack.com/archives/C0BVC5WS88G"', 'href="/oncall/report"']) {
      expect(html).toContain(marker);
    }
  });
});

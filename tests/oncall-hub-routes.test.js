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
});

describe('on-call hub page contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'oncall.html'), 'utf8');

  test('hub keeps the shared on-call mechanics', () => {
    for (const marker of ['href="https://coggtm.slack.com/archives/C0BVC5WS88G"', 'href="/oncall/report"']) {
      expect(html).toContain(marker);
    }
  });
});

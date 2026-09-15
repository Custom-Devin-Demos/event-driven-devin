const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const oncallRoutes = require('../app/routes/oncall');
const { listOncallSkins } = require('../config/oncall-skins');

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
  test('/oncall and /oncall/branded serve the same hub page', async () => {
    const [stock, branded] = await Promise.all([
      fetch(`${baseUrl}/oncall`),
      fetch(`${baseUrl}/oncall/branded`),
    ]);
    expect(stock.status).toBe(200);
    expect(branded.status).toBe(200);
    expect(await branded.text()).toEqual(await stock.text());
  });

  test('"branded" is never treated as a vertical slug', async () => {
    const res = await fetch(`${baseUrl}/oncall/branded/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
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

  test('/api/oncall/skins feeds the branded hub with the listed skins only', async () => {
    const res = await fetch(`${baseUrl}/api/oncall/skins`);
    expect(res.status).toBe(200);
    const { skins } = await res.json();
    expect(skins).toEqual(listOncallSkins());
    expect(skins.some((s) => s.slug === '63dbb52f')).toBe(true);
  });
});

describe('on-call hub page contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'oncall.html'), 'utf8');

  test('nav carries the branded link and the page switches on /oncall/branded', () => {
    expect(html).toContain('href="/oncall/branded"');
    expect(html).toMatch(/location\.pathname[^\n]*'\/oncall\/branded'/);
  });

  test('branded mode has the storage banner and never a stock hub section listing customers', () => {
    expect(html).toContain('This is for storing branded customer demos');
    expect(html).not.toContain('id="branded-section"');
  });

  test('branded mode keeps the shared on-call mechanics on the page', () => {
    for (const marker of ['id="incident-btn"', 'href="/oncall/report"', 'id="health-strip"', '/api/oncall/infra/state']) {
      expect(html).toContain(marker);
    }
  });
});

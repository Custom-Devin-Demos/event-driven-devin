const express = require('express');
const http = require('http');
const router = require('../app/routes/verticals/commbankapp');

describe('CommBank Flutter web build hosting (/commbankapp)', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(router);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.closeAllConnections();
    server.close(done);
  });

  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

  test('redirects the bare path and friendly entry points to the hosted build', async () => {
    const bare = await fetch(url('/commbankapp'), { redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe('/commbankapp/');

    for (const entry of ['/commbank-app', '/cba-app', '/cba/app', '/commbank/app']) {
      const res = await fetch(url(entry), { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/commbankapp/');
    }
  });

  test('serves the Flutter build with the matching base href and falls back to index.html for deep links', async () => {
    const index = await fetch(url('/commbankapp/'));
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<base href="/commbankapp/">');
    expect(html).toContain('<title>CommBank</title>');

    const deep = await fetch(url('/commbankapp/pay/sunrise-plumbing'));
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
  });

  test('build assets revalidate on every load', async () => {
    for (const asset of ['/commbankapp/', '/commbankapp/main.dart.js', '/commbankapp/manifest.json']) {
      const res = await fetch(url(asset));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  test('entry scripts carry a per-build version so a deploy busts the CDN and browser caches', async () => {
    const html = await (await fetch(url('/commbankapp/'))).text();
    const [, version] = html.match(/src="flutter_bootstrap\.js\?v=([0-9a-f]{12})"/);
    expect(version).toBeDefined();

    const bootstrap = await fetch(url(`/commbankapp/flutter_bootstrap.js?v=${version}`));
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.text()).toContain(`"mainJsPath":"main.dart.js?v=${version}"`);
  });

  test('does not ship the unused local CanvasKit bundle (loaded from the Flutter CDN)', async () => {
    const res = await fetch(url('/commbankapp/canvaskit/canvaskit.wasm'));
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

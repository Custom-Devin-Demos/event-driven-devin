const express = require('express');
const http = require('http');
const router = require('../app/routes/verticals/commbizapp');

describe('CommBiz Flutter web build hosting (/commbizapp)', () => {
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
    const bare = await fetch(url('/commbizapp'), { redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe('/commbizapp/');

    for (const entry of ['/commbiz', '/commbiz-app', '/commbiz/app']) {
      const res = await fetch(url(entry), { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/commbizapp/');
    }
  });

  test('serves the Flutter build with the matching base href and falls back to index.html for deep links', async () => {
    const index = await fetch(url('/commbizapp/'));
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<base href="/commbizapp/">');
    expect(html).toContain('<title>CommBiz</title>');

    const deep = await fetch(url('/commbizapp/authorise/wages-week-43'));
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
  });

  test('build assets revalidate on every load', async () => {
    for (const asset of ['/commbizapp/', '/commbizapp/main.dart.js', '/commbizapp/manifest.json']) {
      const res = await fetch(url(asset));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  test('entry scripts carry a per-build version so a deploy busts the CDN and browser caches', async () => {
    const html = await (await fetch(url('/commbizapp/'))).text();
    const [, version] = html.match(/src="flutter_bootstrap\.js\?v=([0-9a-f]{12})"/);
    expect(version).toBeDefined();

    const bootstrap = await fetch(url(`/commbizapp/flutter_bootstrap.js?v=${version}`));
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.text()).toContain(`"mainJsPath":"main.dart.js?v=${version}"`);
  });

  test('does not ship the unused local CanvasKit bundle (loaded from the Flutter CDN)', async () => {
    const res = await fetch(url('/commbizapp/canvaskit/canvaskit.wasm'));
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

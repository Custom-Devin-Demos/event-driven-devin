/**
 * The deployed tree on the EC2 host can contain vertical files the repo no
 * longer has (deploys never deleted). Discovery must tolerate them: a broken
 * module is skipped, a page that shadows an alias loses to the alias, and the
 * app still boots.
 *
 * Runs against a scratch copy of the tree (symlinked back to the real
 * services/config/node_modules) so it never touches the repo checkout.
 */
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'app', 'routes', 'verticals');
const PAGES_DIR = path.join(ROOT, 'app', 'public', 'verticals');

const STALE = 'zz-stale-test';
const SHADOW_ALIAS = 'publix';
const SHADOW_TARGET = '4c351052';

let tmp;
let server;
let baseUrl;
let verticalRoutes;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function buildScratchTree() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verticals-stale-'));
  const scratchRoutes = path.join(tmp, 'app', 'routes', 'verticals');
  const scratchPages = path.join(tmp, 'app', 'public', 'verticals');
  fs.mkdirSync(scratchRoutes, { recursive: true });
  fs.mkdirSync(scratchPages, { recursive: true });

  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
  fs.symlinkSync(path.join(ROOT, 'config'), path.join(tmp, 'config'));
  fs.symlinkSync(path.join(ROOT, 'app', 'services'), path.join(tmp, 'app', 'services'));
  fs.symlinkSync(path.join(ROOT, 'app', 'telemetry'), path.join(tmp, 'app', 'telemetry'));
  fs.symlinkSync(path.join(ROOT, 'app', 'middleware'), path.join(tmp, 'app', 'middleware'));

  for (const f of fs.readdirSync(ROUTES_DIR)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(ROUTES_DIR, f), path.join(scratchRoutes, f));
  }
  for (const f of fs.readdirSync(PAGES_DIR)) {
    if (f.endsWith('.html')) fs.symlinkSync(path.join(PAGES_DIR, f), path.join(scratchPages, f));
  }

  fs.writeFileSync(path.join(scratchRoutes, `${STALE}.js`), "require('../../services/verticals/zz-stale-test-missing');\n");
  fs.writeFileSync(path.join(scratchPages, `${STALE}.html`), '<html>stale</html>\n');
  if (fs.existsSync(path.join(scratchPages, `${SHADOW_ALIAS}.html`))) {
    throw new Error(`${SHADOW_ALIAS}.html exists in the repo; pick another alias for this test`);
  }
  fs.writeFileSync(path.join(scratchPages, `${SHADOW_ALIAS}.html`), '<html>stale publix</html>\n');

  return path.join(scratchRoutes, 'index.js');
}

beforeAll((done) => {
  const scratchIndex = buildScratchTree();
  jest.isolateModules(() => {
    verticalRoutes = require(scratchIndex);
  });

  const app = express();
  app.use(verticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  server.close(done);
});

test('a route module that fails to load is skipped, not fatal', () => {
  expect(verticalRoutes.skippedRouteIds).toEqual([STALE]);
  expect(verticalRoutes.routeIds).not.toContain(STALE);
  expect(verticalRoutes.routeIds).toEqual(expect.arrayContaining(['banking', 'qbe']));
});

test('a stale page is still served by direct URL', async () => {
  const { status, body } = await get(`/${STALE}`);
  expect(status).toBe(200);
  expect(body).toContain('stale');
});

test('an alias wins over a stale page of the same name', async () => {
  expect(verticalRoutes.aliases[SHADOW_ALIAS]).toBe(SHADOW_TARGET);
  const [viaAlias, viaTarget] = await Promise.all([get(`/${SHADOW_ALIAS}`), get(`/${SHADOW_TARGET}`)]);
  expect(viaAlias.status).toBe(200);
  expect(viaAlias.body).toBe(viaTarget.body);
  expect(viaAlias.body).not.toContain('stale publix');
});

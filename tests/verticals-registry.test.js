const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = 'test';

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'app', 'routes', 'verticals');
const PAGES_DIR = path.join(ROOT, 'app', 'public', 'verticals');
const SERVICES_DIR = path.join(ROOT, 'app', 'services', 'verticals');
const CUSTOMERS_DIR = path.join(ROOT, 'config', 'customers');

const verticalRoutes = require('../app/routes/verticals');
const { CUSTOMERS, listAliases, getCustomerConfig } = require('../config/customers');

const { routeIds, skippedRouteIds, pageIds, aliases, VERTICALS } = verticalRoutes;

let server;
let baseUrl;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(verticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('vertical discovery', () => {
  test('mounts every route module in app/routes/verticals', () => {
    const expected = fs.readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .map((f) => f.slice(0, -3))
      .sort();
    expect(routeIds).toEqual(expected);
    expect(skippedRouteIds).toEqual([]);
    expect(routeIds).toEqual(expect.arrayContaining(['banking', 'qbe', '4f645972', '4b7e1d37']));
  });

  test('serves every page in app/public/verticals at /<id>', () => {
    const expected = fs.readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.slice(0, -5))
      .sort();
    expect(pageIds).toEqual(expected);
    expect(pageIds.length).toBeGreaterThan(150);
  });

  test('every page responds 200 by direct URL', async () => {
    const failures = [];
    for (const id of pageIds) {
      const { status } = await get(`/${id}`);
      if (status !== 200) failures.push(`${id}:${status}`);
    }
    expect(failures).toEqual([]);
  }, 60000);

  test('every alias responds 200 with its target page', async () => {
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    expect(aliases).toMatchObject({
      publix: '4c351052',
      morganstanley: 'c7d11cb8',
      databricks: '0b6164d6',
      citizens: '2ab0c5c9',
      'welcome-season': 'payer',
    });
    const failures = [];
    for (const [alias, id] of Object.entries(aliases)) {
      const [viaAlias, viaId] = await Promise.all([get(`/${alias}`), get(`/${id}`)]);
      if (viaAlias.status !== 200 || viaAlias.body !== viaId.body) {
        failures.push(`${alias}->${id}:${viaAlias.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 60000);

  test('hub metadata and /retail and / are unchanged', async () => {
    expect(VERTICALS.map((v) => v.id)).toEqual([
      'retail', 'banking', 'financial-services', 'insurance', 'cpg',
      'hightech', 'industrials', 'healthcare', 'telco',
    ]);
    const api = await get('/api/verticals');
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body).verticals).toHaveLength(9);
    expect((await get('/retail')).status).toBe(200);
    expect((await get('/')).status).toBe(200);
  });
});

describe('customer config discovery', () => {
  test('loads every config/customers/<slug>.js plus the inline default', () => {
    const files = fs.readdirSync(CUSTOMERS_DIR).filter((f) => f.endsWith('.js'));
    expect(files).not.toContain('default.js');
    const slugs = files.map((f) => f.slice(0, -3)).sort();
    expect(Object.keys(CUSTOMERS).filter((s) => s !== 'default').sort()).toEqual(slugs);
    expect(CUSTOMERS.default.label).toBe('Default (landing page demos)');
  });

  test('every customer entry has a label and only known keys', () => {
    const allowed = new Set([
      'label',
      'triggerMode',
      'githubOrg',
      'aliases',
      'itsm',
      'itsmAssignmentGroup',
    ]);
    const problems = [];
    for (const [slug, entry] of Object.entries(CUSTOMERS)) {
      if (typeof entry.label !== 'string' || !entry.label) problems.push(`${slug}: missing label`);
      for (const key of Object.keys(entry)) {
        if (!allowed.has(key)) problems.push(`${slug}: unexpected key ${key}`);
      }
      if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) problems.push(`${slug}: aliases must be an array`);
    }
    expect(problems).toEqual([]);
  });

  test('aliases are unique, point at existing pages, and never shadow a page', () => {
    const map = listAliases();
    const problems = [];
    for (const [alias, slug] of Object.entries(map)) {
      if (!pageIds.includes(slug)) problems.push(`/${alias} -> missing page ${slug}.html`);
      if (pageIds.includes(alias)) problems.push(`/${alias} shadows page ${alias}.html`);
    }
    expect(problems).toEqual([]);
  });

  test('every customer slug referenced by a vertical service has a config entry', () => {
    const referenced = new Set();
    for (const file of fs.readdirSync(SERVICES_DIR)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf8');
      for (const m of src.matchAll(/^\s*customer: '([A-Za-z0-9_-]+)',?\s*$/gm)) referenced.add(m[1]);
    }
    expect(referenced.size).toBeGreaterThan(100);
    const missing = [...referenced].filter((slug) => !CUSTOMERS[slug]).sort();
    expect(missing).toEqual([]);
  });

  test('getCustomerConfig keeps suffixed env-var resolution', () => {
    process.env.DEVIN_SERVICE_KEY_4C351052 = 'publix-key';
    process.env.DEVIN_ORG_ID_4C351052 = 'org-publix';
    const previousGlobalOrg = process.env.DEVIN_ORG_ID;
    process.env.DEVIN_ORG_ID = 'org-global';
    try {
      expect(getCustomerConfig('4c351052')).toMatchObject({
        customer: '4c351052', label: 'Publix', apiKey: 'publix-key', devinOrgId: 'org-publix',
      });
      expect(getCustomerConfig('6dc826a1').githubOrg).toBe('COG-GTM');
      expect(getCustomerConfig('6dc826a1').devinOrgId).toBe('');
      expect(getCustomerConfig(undefined)).toMatchObject({ customer: 'default', devinOrgId: '' });
    } finally {
      delete process.env.DEVIN_SERVICE_KEY_4C351052;
      delete process.env.DEVIN_ORG_ID_4C351052;
      if (previousGlobalOrg === undefined) delete process.env.DEVIN_ORG_ID;
      else process.env.DEVIN_ORG_ID = previousGlobalOrg;
    }
  });
});

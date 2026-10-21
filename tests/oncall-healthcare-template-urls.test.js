/* global afterAll, beforeAll, describe, expect, jest, test, fetch */

const express = require('express');
const http = require('http');

const HEALTHCARE_FIXTURES = {
  hc0pbm01: { slug: 'hc0pbm01', company: 'Fixture PBM', brandMark: 'F', vertical: 'pbm' },
  hc0pay01: { slug: 'hc0pay01', company: 'Fixture Plan', brandMark: 'F', vertical: 'payer' },
  hc0lsc01: { slug: 'hc0lsc01', company: 'Fixture Pharma', brandMark: 'F', vertical: 'lifesciences' },
};

jest.mock('../config/oncall-skins', () => {
  const actual = jest.requireActual('../config/oncall-skins');
  const skins = { ...actual.ONCALL_SKINS, ...HEALTHCARE_FIXTURES };
  return {
    ONCALL_SKINS: skins,
    getOncallSkin: (slug) => {
      if (!slug || typeof slug !== 'string') return null;
      const key = slug.toLowerCase();
      return Object.prototype.hasOwnProperty.call(skins, key) ? skins[key] : null;
    },
  };
});

const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const oncallRoutes = require('../app/routes/oncall');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { ONCALL_SKINS } = require('../config/oncall-skins');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(oncallRoutes);
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

const statusOf = async (urlPath) => (await fetch(`${baseUrl}${urlPath}`)).status;

describe('healthcare skins served under their base template', () => {
  test('each fixture skin is served at /oncall/healthcare/<template>/<slug> and still at /oncall/c/<slug>', async () => {
    for (const skin of Object.values(HEALTHCARE_FIXTURES)) {
      expect(ALERT_SCENARIOS[skin.vertical].group).toBe('healthcare');
      const [templateRes, legacyRes] = await Promise.all([
        fetch(`${baseUrl}/oncall/healthcare/${skin.vertical}/${skin.slug}`),
        fetch(`${baseUrl}/oncall/c/${skin.slug}`),
      ]);
      expect(templateRes.status).toBe(200);
      expect(templateRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      const [templateHtml, legacyHtml] = await Promise.all([templateRes.text(), legacyRes.text()]);
      expect(templateHtml).toBe(legacyHtml);
      expect(templateHtml).toContain(skin.company);
    }
  });

  test('a healthcare skin under a different template 404s', async () => {
    expect(await statusOf('/oncall/healthcare/payer/hc0pbm01')).toBe(404);
    expect(await statusOf('/oncall/healthcare/lifesciences/hc0pbm01')).toBe(404);
    expect(await statusOf('/oncall/healthcare/pbm/hc0pay01')).toBe(404);
    expect(await statusOf('/oncall/healthcare/pbm/hc0nope0')).toBe(404);
    expect(await statusOf('/oncall/healthcare/pbm/hc0pbm01/report')).toBe(404);
    expect(await statusOf('/oncall/pbm/hc0pbm01')).toBe(404);
  });

  test('non-healthcare skins get no template URL', async () => {
    const others = Object.values(ONCALL_SKINS)
      .filter((skin) => ALERT_SCENARIOS[skin.vertical] && ALERT_SCENARIOS[skin.vertical].group !== 'healthcare')
      .slice(0, 5);
    expect(others.length).toBeGreaterThan(0);
    for (const skin of others) {
      expect(await statusOf(`/oncall/healthcare/${skin.vertical}/${skin.slug}`)).toBe(404);
      expect(await statusOf(`/oncall/healthcare/pbm/${skin.slug}`)).toBe(404);
    }
  });

  test('/oncall/healthcare/<template> serves the same page as /oncall/<template>', async () => {
    for (const template of ['pbm', 'payer', 'lifesciences']) {
      const [nested, direct] = await Promise.all([
        fetch(`${baseUrl}/oncall/healthcare/${template}`),
        fetch(`${baseUrl}/oncall/${template}`),
      ]);
      expect(nested.status).toBe(200);
      expect(await nested.text()).toBe(await direct.text());
    }
    expect(await statusOf('/oncall/healthcare/banking')).toBe(404);
  });

  test('template pages and hubs are unchanged', async () => {
    for (const urlPath of ['/oncall', '/oncall/healthcare', '/oncall/pbm', '/oncall/payer', '/oncall/lifesciences']) {
      expect(await statusOf(urlPath)).toBe(200);
    }
  });
});

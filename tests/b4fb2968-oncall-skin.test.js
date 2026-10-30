jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

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
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

function check(body) {
  return fetch(`${baseUrl}/api/oncall/coveragecheck/coverage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TITLE = 'What brings you to Pomelo? | Pomelo Care';

describe('b4fb2968 Pomelo Care signup coverage-check on-call skin', () => {
  test('is a native, unlisted coveragecheck skin routed straight to a Devin session', () => {
    const skin = getOncallSkin('b4fb2968');
    expect(skin).toMatchObject({ vertical: 'coveragecheck', oncallOnly: true, alertDestination: 'devin', page: { file: 'b4fb2968.html', title: TITLE } });
    expect(skin.devinSession).toMatchObject({
      auto: true, pinIdentity: true, orgId: 'org_69IXJFLrljx8zSAw', userId: 'email|698b4ec82a96a7c11bae5936',
    });
    expect(skin.devinSession.promptAppendix).not.toMatch(/(Post|back) in the alert thread|thread replies/i);
    expect(ALERT_SCENARIOS.coveragecheck).toMatchObject({
      apiPath: '/api/b4fb2968/coverage', oncallApiPath: '/api/oncall/coveragecheck/coverage', triggerWhen: { insurer: 'bcbs-tx' }, unlisted: true,
    });
    expect(JSON.stringify(ALERT_SCENARIOS.coveragecheck) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|NETWORK_CONTRACTS|BCBSTX-HCSC|payerId/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/b4fb2968', '/b4fb2968', '/pomelo', '/pomelocare', '/pomelo-care'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    pages.slice(1).forEach((page) => expect(page).toEqual(pages[0]));
    const html = pages[0];
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/b4fb2968/coverage'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/coveragecheck/coverage"');
    expect(html).toContain('const triggerWhen = {"insurer":"bcbs-tx"}');
    expect(html).toContain('var skinAlertDestination = "devin"');
    expect(html).toMatch(/demo=1[\s\S]*state: 'TX'[\s\S]*check-coverage-insurance/);
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('coverage check fails with a 500 TypeError for Blue Cross Blue Shield of Texas', async () => {
    const res = await check({ state: 'TX', insurer: 'bcbs-tx' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'COVERAGE_CHECK_FAILED' });
  });

  test.each(['aetna', 'cigna', 'unitedhealthcare'])('coverage check returns in-network for %s', async (insurer) => {
    const res = await check({ state: 'TX', insurer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, covered: true });
  });

  test('out-of-network insurers return covered: false', async () => {
    const res = await check({ state: 'TX', insurer: 'molina' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, covered: false, estimatedCostCents: null });
  });

  test('unknown insurers or states return 400', async () => {
    expect((await check({ state: 'TX', insurer: 'acme' })).status).toBe(400);
    expect((await check({ state: 'Texas', insurer: 'aetna' })).status).toBe(400);
    expect((await check({ state: 'ZZ', insurer: 'aetna' })).status).toBe(400);
  });
});

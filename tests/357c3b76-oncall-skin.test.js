jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
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
  server.close(done);
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TITLE = 'Deploy blueprint | Blueprints | Dell Automation Platform';

describe('357c3b76 Dell Automation Platform blueprint deploy on-call skin', () => {
  test('is a native, unlisted privatecloud skin without report or incident surfaces', () => {
    const skin = getOncallSkin('357c3b76');
    expect(skin).toMatchObject({ vertical: 'privatecloud', oncallOnly: true, alertDestination: 'slack', page: { file: '357c3b76.html', title: TITLE } });
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A DELL TECHNOLOGIES SITE/);
    const scenario = ALERT_SCENARIOS.privatecloud;
    expect(scenario).toMatchObject({
      apiPath: '/api/357c3b76/deployments', oncallApiPath: '/api/oncall/privatecloud/deployments', triggerWhen: { blueprintId: 'dpc-vsphere' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|STORAGE_PROFILES|PS-3200T|datastoreTemplate/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/357c3b76', '/357c3b76', '/dell', '/dap', '/dell-dap'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/357c3b76/deployments'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/privatecloud/deployments"');
    expect(html).toContain('const triggerWhen = {"blueprintId":"dpc-vsphere"}');
    expect(html).toContain('NOT ACTUALLY A DELL TECHNOLOGIES SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/357c3b76/report`),
      fetch(`${baseUrl}/oncall/c/357c3b76/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Deploy fails with a 500 TypeError for the vSphere blueprint', async () => {
    const res = await post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-vsphere', siteId: 'rr-dc02', clusterName: 'dpc-rr02-prod-01', nodeCount: 4 });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'DEPLOYMENT_FAILED' });
    expect(JSON.stringify(body)).not.toMatch(/STORAGE_PROFILES|PS-3200T|datastoreTemplate|\.js/);
  });

  test.each(['dpc-openshift', 'dpc-nutanix'])('Deploy succeeds for %s', async (blueprintId) => {
    const res = await post('/api/oncall/privatecloud/deployments', { blueprintId, siteId: 'hop-dc01', clusterName: 'dpc-hop01-prod-01', nodeCount: 3 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, site: 'Hopkinton DC-01', status: 'Creating deployments' });
    expect(body.storage).toEqual(expect.objectContaining({ array: expect.any(String), protocol: expect.any(String) }));
  });

  test('wizard selections are applied and echoed in the plan', async () => {
    const res = await post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-openshift', siteId: 'rr-dc02', clusterName: 'dpc-rr02-prod-02', nodeCount: 3, storagePolicy: 'performance', target: 'bare-metal', secret: 'dpc-shared-admin-credentials' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, secret: 'dpc-shared-admin-credentials', target: 'Bare metal (managed by orchestrator)' });
    expect(body.storage).toMatchObject({ datastoreTemplate: 'perf-nodedupe', policy: 'Performance (NVMe/TCP, no dedupe)' });
  });

  test('Nutanix deploys to the XR8000 edge site but R760 blueprints do not', async () => {
    const ok = await post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-nutanix', siteId: 'lim-edge04', clusterName: 'dpc-lim04-prod-01', nodeCount: 3 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, nodes: '3 \u00d7 PowerEdge XR8000' });
    const bad = await post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-openshift', siteId: 'lim-edge04', clusterName: 'dpc-lim04-prod-01', nodeCount: 3 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ success: false, code: 'INVALID_DEPLOYMENT' });
  });

  test('unknown blueprints, sites, options and out-of-range node counts return 400', async () => {
    const bad = await Promise.all([
      post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-azure', siteId: 'rr-dc02', nodeCount: 4 }),
      post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-openshift', siteId: 'mars-01', nodeCount: 4 }),
      post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-nutanix', siteId: 'lim-edge04', nodeCount: 12 }),
      post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-openshift', siteId: 'rr-dc02', nodeCount: 4, target: 'vcenter' }),
      post('/api/oncall/privatecloud/deployments', { blueprintId: 'dpc-openshift', siteId: 'rr-dc02', nodeCount: 4, storagePolicy: 'gold' }),
    ]);
    bad.forEach((res) => expect(res.status).toBe(400));
  });
});

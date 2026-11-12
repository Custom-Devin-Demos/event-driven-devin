/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() }, initSentry: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ tracer: { trace: jest.fn((_name, _options, fn) => fn()) }, incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn() }));
jest.mock('../app/services/datadog-incident-slack', () => ({ queueIncidentChannelInvites: jest.fn() }));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { queueIncidentChannelInvites } = require('../app/services/datadog-incident-slack');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { incrementMetric } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const { getOncallSkin } = require('../config/oncall-skins');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');


const SLUG = '9b95c6e1';
const API = '/api/oncall/logicbroker';
let server;
let baseUrl;
const post = (url, body) => fetch(baseUrl + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('../app/routes/oncall'));
  app.use(require('../app/routes/oncall-verticals'));
  server = http.createServer(app).listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await stopGateway();
});
beforeEach(() => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  createDevinSession.mockResolvedValue({ sessionId: 'lb-routing', url: 'https://app.devin.ai/sessions/lb-routing' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 412 });
});
function freshService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/logicbroker-reroute'); });
  return service;
}
describe('Logicbroker Order Routing on-call skin', () => {
  test('aliases serve the native workbench with the release alert shim', async () => {
    for (const url of ['/logicbroker', '/logicbroker-oncall', '/oncall/c/' + SLUG]) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Order Routing | Logicbroker</title>');
      expect(html.match(/NOT ACTUALLY A LOGICBROKER SITE/g)).toHaveLength(1);
      expect(html).toContain('const oncallApiPath = "/api/oncall/logicbroker/release"');
      expect(html).toContain('const alertOnStatus = [500]');
      expect(html).toContain('var skinAlertDestination = "slack"');
      const brandingScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .find((script) => script[1].includes('var disclaimer ='))[1];
      const firstChild = {};
      const document = { querySelector: () => null, createElement: () => ({ style: {} }), body: { firstChild, insertBefore: jest.fn() } };
      vm.runInNewContext(brandingScript, { document });
      expect(document.body.insertBefore).toHaveBeenCalledWith(expect.objectContaining({ textContent: getOncallSkin(SLUG).disclaimer }), firstChild);
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(script[1])).not.toThrow();
    }
  });
  test('outage, error, split and toast are hidden initially', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/9b95c6e1.html'), 'utf8');
    for (const id of ['outage', 'releaseError', 'plan', 'toast']) expect(html).toMatch(new RegExp('id="' + id + '"[^>]*hidden'));
    expect(html).toContain('showModal()');
  });
  test('regular alert starts a scoped investigation, not an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.devinSession.auto).toBe(true);
    expect(skin.devinSession.onCallIsTriggerer).toBe(true);
    expect(skin.oncallOnly).toBe(true);
    expect(skin.onCallSlackMemberId).toBe('U0BQZBHCNMA');
    expect(skin.datadogIncident).toBeUndefined();
    const result = await postOncallAlert('logicbrokerrouting', { skin, runRef: 'lb-test' });
    expect(result.ok).toBe(true);
    expect(postMessage.mock.calls[0][2]).toContain('lb-order-routing-api');
    expect(createDevinSession.mock.calls[0][0]).toContain('logicbroker-routing.js');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(postThreadReply).toHaveBeenCalled();
  });
  test('evaluate returns a scored five-supplier plan totaling 200 and release always fails', async () => {
    for (const orderId of ['PO28371271-001', 'PO28371272-001', 'PO28371273-001']) {
      const evaluated = await post(API + '/evaluate', { orderId });
      expect(evaluated.status).toBe(200);
      const plan = await evaluated.json();
      expect(plan.allocations).toHaveLength(5);
      expect(plan.allocations.map((item) => item.quantity)).toEqual([100, 10, 15, 30, 45]);
      expect(plan.allocations.map((item) => item.slaCutoff)).toEqual(['18:00 ET', '18:00 ET', '20:00 ET', '18:00 ET', '17:00 ET']);
      expect(plan.allocations.reduce((sum, item) => sum + item.quantity, 0)).toBe(200);
      const release = await post(API + '/release', { orderId, allocations: [] });
      expect(release.status).toBe(500);
      expect(await release.json()).toMatchObject({ success: false, code: 'ROUTING_RELEASE_FAILED' });
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException.mock.calls[0][0].message).toContain("reading 'cutoffHour'");
    expect(incrementMetric).toHaveBeenCalledWith('logicbroker.routing.failure', expect.objectContaining({ service: 'lb-order-routing-api' }));
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test('with the missing rule restored, late releases schedule all POs without dropping suppliers', async () => {
    let service;
    jest.isolateModules(() => { service = require('../app/services/oncall-verticals/logicbroker-routing'); });
    service.SLA_CUTOFF_RULES.GROUND_3PL = { cutoffHour: 17 };
    jest.useFakeTimers();
    try {
      for (const [time, groundDate, expressDate] of [
        ['2026-11-12T23:00:00Z', '2026-11-13', '2026-11-12'],
        ['2026-11-13T23:00:00Z', '2026-11-16', '2026-11-13'],
        ['2026-11-14T12:00:00Z', '2026-11-16', '2026-11-16'],
      ]) {
        jest.setSystemTime(new Date(time));
        const result = await service.releaseSupplierPOs({ orderId: 'PO28371271-001' });
        expect(result.success).toBe(true);
        expect(result.allocations).toHaveLength(5);
        expect(result.allocations.every((item) => item.status === 'Released')).toBe(true);
        expect(result.allocations.reduce((sum, item) => sum + item.quantity, 0)).toBe(200);
        expect(result.allocations.map((item) => item.shipBy)).toEqual([
          groundDate + ' 18:00 ET', groundDate + ' 18:00 ET', expressDate + ' 20:00 ET',
          groundDate + ' 18:00 ET', groundDate + ' 17:00 ET',
        ]);
      }
    } finally {
      jest.useRealTimers();
      delete service.SLA_CUTOFF_RULES.GROUND_3PL;
    }
  });
  test('empty and invalid routing requests are rejected without telemetry', async () => {
    for (const endpoint of ['/evaluate', '/release']) {
      for (const body of [{}, { orderId: 'unknown' }, { orderId: null }]) {
        expect((await post(API + endpoint, body)).status).toBe(400);
      }
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test('reroute returns 503, declares SEV-1, invites participant and reuses incident', async () => {
    const first = await post(API + '/reroute', { batchId: 'LB-SLA-2048' });
    expect(first.status).toBe(503);
    const body = await first.json();
    expect(body.incident).toMatchObject({ status: 'declared', channelPrefix: 'sev-1-incident' });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-1', service: 'lb-sla-reroute' }));
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 412, userIds: ['U0BQZBHCNMA'] });
    const repeat = await post(API + '/reroute', { batchId: 'LB-SLA-2048' });
    expect(repeat.status).toBe(503);
    expect((await repeat.json()).incident).toMatchObject({ reused: true, runRef: body.incident.runRef });
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
  });
  test('invalid rerouting does not declare an incident', async () => {
    expect((await post(API + '/reroute', {})).status).toBe(400);
    expect((await post(API + '/reroute', { batchId: 'unknown' })).status).toBe(400);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test('concurrent reroutes share an incident; expiry allows a new one', async () => {
    const { rerouteOrders } = freshService();
    const results = await Promise.all([1, 2, 3].map(() => rerouteOrders({ batchId: 'LB-SLA-2048' })));
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.body.incident.runRef)).size).toBe(1);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try { await rerouteOrders({ batchId: 'LB-SLA-2048' }); } finally { clock.mockRestore(); }
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });
  test('incident provider failures preserve the outage and allow retries', async () => {
    const { rerouteOrders } = freshService();
    declareDatadogIncident.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Datadog 403'));
    expect((await rerouteOrders({ batchId: 'LB-SLA-2048' })).body.incident.status).toBe('unavailable');
    expect((await rerouteOrders({ batchId: 'LB-SLA-2048' })).body.incident.status).toBe('failed');
    expect((await rerouteOrders({ batchId: 'LB-SLA-2048' })).body.incident.status).toBe('declared');
  });
});

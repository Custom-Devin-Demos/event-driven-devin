jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve(null)),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const e7fd3feeRoutes = require('../app/routes/verticals/e7fd3fee');
const { ALERT_SCENARIOS, buildOncallSessionPrompt } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { getOncallSkin } = require('../config/oncall-skins');
const { createSessionAndAlert } = require('../app/services/devin-session');
const logger = require('../app/telemetry/logger');

const SKIN = '1d03555d';
const OLB = `/oncall/c/${SKIN}/olb`;
let server;
let baseUrl;

beforeAll((done) => {
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  app.use(e7fd3feeRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => {
    stopGateway().then(() => done());
  });
});

function chat(body, headers = {}) {
  return fetch(`${baseUrl}/api/oncall/ericadispute/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-1', ...headers },
    body: JSON.stringify(body),
  });
}

async function stageDispute(match, headers) {
  const res = await chat({ text: "I don't recognize a charge" }, headers);
  const chip = (await res.json()).messages[0].chips.find((c) => c.label.includes(match));
  const staged = await (await chat({ action: chip.action }, headers)).json();
  return staged.messages.find((m) => m.card && m.card.type === 'lock_dispute_confirm').card.actions[0].action;
}

describe('Online Banking + Erica on-call skin (1d03555d)', () => {
  const fromSkin = { 'X-Oncall-Skin': SKIN };
  beforeEach(() => createSessionAndAlert.mockClear());

  test('pages #oncall-alerts with an immediate Devin session from the e7fd3fee homepage and replica', () => {
    const skin = getOncallSkin(SKIN);
    expect(skin).toMatchObject({
      vertical: 'ericadispute', siteReplica: 'e7fd3fee-olb', alertDestination: 'slack', page: { file: 'e7fd3fee.html' },
      devinSession: { auto: true, onCallIsTriggerer: true },
    });
    expect(skin.alertPath).toBeUndefined();
    expect(ALERT_SCENARIOS.ericadispute).toMatchObject({
      apiPath: '/api/e7fd3fee/erica/chat', oncallApiPath: '/api/oncall/ericadispute/chat', alertOnStatus: [500], unlisted: true,
    });
  });

  test('the session prompt asks for a local before/after recording of the Erica dispute', () => {
    const prompt = buildOncallSessionPrompt(ALERT_SCENARIOS.ericadispute, getOncallSkin(SKIN), 'ref-1');
    expect(prompt).toContain('POST /api/oncall/ericadispute/chat');
    expect(prompt).toContain('recording_start');
    expect(prompt).toContain('/oncall/c/1d03555d/olb/accounts');
    expect(prompt).toContain('never on the live page');
  });

  test('skin URL and friendly path serve the shimmed homepage with Log in pointing at the skin replica', async () => {
    const [skinned, friendly] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/${SKIN}`).then((r) => r.text()),
      fetch(`${baseUrl}/bofa-erica-oncall`).then((r) => r.text()),
    ]);
    expect(friendly).toEqual(skinned);
    expect(skinned).toContain(`window.location.href='${OLB}/login'`);
    expect(skinned).not.toContain('/e7fd3fee/olb');
    expect(skinned).toContain('const automatedAlertPath = false');
    expect(skinned).toContain('const alertOnStatus = [500]');
    expect(skinned).toContain('NOT ACTUALLY A BANK OF AMERICA SITE');
  });

  test('replica pages are served under the skin with links, assets and the shim rebased', async () => {
    const res = await fetch(`${baseUrl}${OLB}/accounts`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('/e7fd3fee/olb');
    expect(html).toContain(`${OLB}/assets/`);
    expect(html).toContain('data-endpoint="/api/e7fd3fee/erica/chat"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/ericadispute/chat"');
    expect((await fetch(`${baseUrl}${OLB}/assets/js/erica.js`)).status).toBe(200);
    expect(html).toContain('id="erica-launcher"');
    expect(html).toMatch(/id="oncall-ribbon" style="[^"]*left:16px/);
  });

  test('sign-in redirects stay inside the skin', async () => {
    const opts = { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    const login = await fetch(`${baseUrl}${OLB}/login`, { ...opts, body: 'online_id=jordan&passcode=x' });
    expect(login.headers.get('location')).toBe(`${OLB}/verify`);
    const verify = await fetch(`${baseUrl}${OLB}/verify`, { ...opts, body: 'otp=123456' });
    expect(verify.headers.get('location')).toBe(`${OLB}/accounts`);
    expect((await fetch(`${baseUrl}${OLB}/nope`, { redirect: 'manual' })).headers.get('location')).toBe(`${OLB}/accounts`);
  });

  test('the legacy /e7fd3fee replica is unchanged', async () => {
    const html = await (await fetch(`${baseUrl}/e7fd3fee/olb/accounts`)).text();
    expect(html).toContain('/e7fd3fee/olb/assets/');
    expect(html).not.toContain('oncall-ribbon');
  });

  test('a Mastercard dispute fails with 500 and the Erica error card, raising no alert server-side', async () => {
    const confirm = await stageDispute('VELOCITY GEAR', fromSkin);
    const res = await chat({ action: confirm }, fromSkin);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'ERICA_ACTION_FAILED', errorClass: 'TypeError' });
    expect(body.messages[0].card).toMatchObject({ type: 'error', title: 'Erica error: dispute not filed' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Visa disputes file', async () => {
    const visa = await stageDispute('TARGET 00023481 CHARLOTTE NC $73.52', fromSkin);
    const ok = await chat({ action: visa }, fromSkin);
    expect(ok.status).toBe(200);
    expect((await ok.json()).messages[0].card).toMatchObject({ type: 'dispute_confirmation' });
  });
});

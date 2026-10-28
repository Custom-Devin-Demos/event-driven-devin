/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { Sentry } = require('../app/telemetry/sentry');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const {
  prepareFulfillment,
  listCollection,
  buildOrder,
  buildFulfillments,
  LISTINGS,
  RELEASE,
} = require('../app/services/oncall-verticals/nftcheckout');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

jest.setTimeout(30000);

const SLUG = '6ec8f942';
const [A, B, C] = LISTINGS.map((l) => l.tokenId);

describe('OpenSea sweep checkout on-call vertical', () => {
  let server;
  let baseUrl;

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

  afterAll((done) => {
    server.closeAllConnections();
    server.close(() => stopGateway().then(() => done()));
  });

  beforeEach(() => jest.clearAllMocks());

  test('orders pay seller proceeds plus 5% creator earnings and multi-item carts aggregate the creator fee', () => {
    const order = buildOrder(LISTINGS[0]);
    const [proceeds, fee] = order.consideration;
    expect(fee.amount * 20n).toBe(proceeds.amount + fee.amount);
    const single = buildFulfillments([order]);
    expect(single.considerationFulfillments.every((c) => c.length === 1)).toBe(true);
    const sweep = buildFulfillments(LISTINGS.slice(0, 3).map(buildOrder));
    expect(sweep.offerFulfillments).toHaveLength(3);
    expect(sweep.considerationFulfillments.map((c) => c.length).sort()).toEqual([1, 1, 1, 3]);
  });

  test('single-item buys succeed without broadcasting', async () => {
    const res = await prepareFulfillment({ tokenIds: [A] });
    expect(res).toMatchObject({ success: true, items: [A] });
    expect(res.transaction).toMatchObject({ method: 'fulfillAdvancedOrder', broadcast: false });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('multi-item checkouts revert with ConsiderationNotMet and report to Sentry', async () => {
    await expect(prepareFulfillment({ tokenIds: [A, B, C] })).rejects.toMatchObject({
      code: 'SEAPORT_REVERT',
      revert: { name: 'ConsiderationNotMet', selector: '0xa5f54208', args: { orderIndex: 1, considerationIndex: 1 } },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ release: RELEASE, revert: 'ConsiderationNotMet' });
  });

  test.each([[{}], [{ tokenIds: [] }], [{ tokenIds: [1] }], [{ tokenIds: LISTINGS.slice(0, 11).map((l) => l.tokenId) }]])(
    'invalid cart %j is a 400 without Sentry',
    async (body) => {
      await expect(prepareFulfillment(body)).rejects.toMatchObject({ code: 'INVALID_CHECKOUT' });
      expect(Sentry.captureException).not.toHaveBeenCalled();
    },
  );

  test('routes: listings are illustrative, sweeps return 422 with the revert, single buys 200', async () => {
    const listings = await (await fetch(`${baseUrl}/api/oncall/nftcheckout/listings`)).json();
    expect(listings.collection.illustrative).toBe(true);
    expect(listings.listings[0].seller).toBeUndefined();
    expect(listCollection().listings).toHaveLength(LISTINGS.length);

    const post = (tokenIds) => fetch(`${baseUrl}/api/oncall/nftcheckout/fulfillment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenIds }),
    });
    const failed = await post([A, B]);
    expect(failed.status).toBe(422);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      success: false,
      code: 'SEAPORT_REVERT',
      step: 'Preparing transaction',
      revert: { name: 'ConsiderationNotMet', selector: '0xa5f54208', method: 'fulfillAvailableAdvancedOrders' },
    });
    expect(JSON.stringify(failedBody)).not.toMatch(/stack|\.js:|shortfall|COG-GTM/i);
    const ok = await post([A]);
    expect(ok.status).toBe(200);
    expect((await ok.json()).success).toBe(true);
    const invalid = await post([]);
    expect(invalid.status).toBe(400);
    await invalid.json();
  });

  test('Slack card is responder-triaged: carries the triage notes, release and metric, no auto session', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.alertDestination).toBe('slack');
    expect(skin.devinSession.auto).toBeUndefined();
    expect(skin.teamsAlerts).toBeUndefined();
    const result = await postOncallAlert('nftcheckout', { skin, runRef: 'run-test' });
    expect(result).toMatchObject({ ok: true, channel: 'C0TEST' });
    expect(createDevinSession).not.toHaveBeenCalled();
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    const card = `${text}\n${JSON.stringify(blocks)}`;
    expect(card).toContain('os-fulfillment-api@2026.10.26');
    expect(card).toContain('ConsiderationNotMet');
    expect(card).toContain('demo.nftcheckout.fulfillment.reverted{service:checkout-api');
    expect(text).toContain('nftcheckout-seaport.js');
    expect(text).toContain('Browser before/after');
    expect(JSON.stringify(blocks)).toContain('Triage notes (OpenSea checkout)');
  });

  test('skins with an auto session keep the appendix off the card', async () => {
    const skin = getOncallSkin('db0a7e02');
    await postOncallAlert('memberlogin', { skin: { ...skin, devinSession: { auto: true, promptAppendix: 'SECRET-APPENDIX' } }, runRef: 'run-test-2' });
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(`${text}${JSON.stringify(blocks)}`).not.toContain('SECRET-APPENDIX');
  });

  test('skin page and aliases serve the native page with the 422-gated shim', async () => {
    const [skinned, alias, short, wrong] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/${SLUG}`),
      fetch(`${baseUrl}/oncall/c/opensea`),
      fetch(`${baseUrl}/opensea-oncall`),
      fetch(`${baseUrl}/oncall/c/00000000`),
    ]);
    expect([skinned.status, alias.status, short.status, wrong.status]).toEqual([200, 200, 200, 404]);
    const html = await skinned.text();
    expect(html).toContain('<title>Puffy Penguins - Collection | OpenSea</title>');
    expect(html).toContain('NOT ACTUALLY AN OPENSEA SITE');
    expect(html).toContain('const apiPath = "/api/opensea-checkout"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/nftcheckout"');
    expect(html).toContain('const alertOnStatus = [422]');
    expect(html).not.toContain('All Demos');
    await Promise.all([alias.text(), short.text(), wrong.text()]);
  });

  test('native page posts to the legacy path, uses no external images and keeps review guards', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/public/verticals', `${SLUG}.html`), 'utf8');
    expect(page).toContain("fetch('/api/opensea-checkout/fulfillment'");
    expect(page).toContain("fetch('/api/config')");
    expect(page).toContain('type="number" min="0" step="any"');
    expect(page).toContain('if (submitted || inFlight || !cart.length) return;');
    expect(page).toMatch(/minmax\(min\(\d+px, 100%\), 1fr\)/);
    expect(page).not.toMatch(/<img|opensea\.io|seadn\.io/i);
  });
});

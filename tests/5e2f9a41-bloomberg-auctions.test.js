const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

jest.mock('../app/services/slack', () => ({
  postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1.1' }),
  joinChannel: jest.fn().mockResolvedValue({ ok: true }),
  buildAlertBlocks: jest.fn(() => []),
  buildAlertText: jest.fn(() => 'alert'),
  resolveOnCallMember: jest.fn().mockResolvedValue('U1'),
}));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));

const slack = require('../app/services/slack');
const { Sentry } = require('../app/telemetry/sentry');
const service = require('../app/services/verticals/5e2f9a41');
const router = require('../app/routes/verticals/5e2f9a41');
const flagMcp = require('../app/routes/bloomberg-feature-flag-mcp');
const { getCustomerConfig, listAliases } = require('../config/customers');

const FLAG = 'auctions.bid-limits-v2';
const bid = { auctionId: 'UKT-4Q34', nominalMn: 250, yieldPct: 4.412 };
let server; let base;

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(flagMcp);
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete process.env.SLACK_ONCALL_BOT_TOKEN;
  service.FLAGS[FLAG] = true;
  service.resetBids();
  service.resetIncidentWindow();
  service.resetFeedbackState();
});

describe('Bloomberg Auction System vertical (5e2f9a41)', () => {
  test('config routes alerts to #bloomberg-oncall and the page uses the API', () => {
    const config = getCustomerConfig('5e2f9a41');
    expect(config.slackChannelId).toBe('C0CKXTAMWQY');
    expect(listAliases()['bloomberg-auctions']).toBe('5e2f9a41');
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5e2f9a41.html'), 'utf8');
    expect(html).toContain("'/api/5e2f9a41'");
    expect(html).toContain('Submit bid');
  });

  test('lists the calendar with one auction open and a future cutoff', async () => {
    const res = await call('GET', '/api/5e2f9a41/auctions');
    expect(res.status).toBe(200);
    expect(res.body.auctions).toHaveLength(3);
    expect(new Date(res.body.auctions[0].cutoff).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.auctions.map((a) => a.status)).toEqual(['OPEN', 'ANNOUNCED', 'ANNOUNCED']);
    expect(res.body.summary).toMatchObject({ open: 1, totalSizeMn: 4000 });
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.bids).toEqual([]);
  });

  test('rejects invalid tickets with 400 and no alert', async () => {
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, auctionId: 'NOPE' })).body.code).toBe('UNKNOWN_AUCTION');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 0 })).body.code).toBe('INVALID_NOMINAL');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, auctionId: 'UKT-4H30' })).body.code).toBe('AUCTION_NOT_OPEN');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, yieldPct: 'x' })).status).toBe(400);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('Submit bid fails with a sanitized 503, records no bid and pages #bloomberg-oncall', async () => {
    const res = await call('POST', '/api/5e2f9a41/bids', bid);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: service.BID_ERROR, code: 'BID_UNAVAILABLE', requestId: expect.stringMatching(/^AUC-/) });
    expect(JSON.stringify(res.body)).not.toMatch(/maxBidMn|undefined/);
    expect(service.getAuctions().bids).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({
      tags: expect.objectContaining({ flag: FLAG, service: service.SERVICE }),
      extra: expect.objectContaining({ auctionSizeAtRiskMn: 4000 }),
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.postMessage.mock.calls[0][1]).toBe('C0CKXTAMWQY');
    expect(slack.buildAlertBlocks.mock.calls[0][1]).toEqual({ includeDevinOnCall: false });
  });

  test('repeat failures inside the incident window post one card', async () => {
    await call('POST', '/api/5e2f9a41/bids', bid);
    await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 100, yieldPct: 4.42 });
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
  });

  test('joins the channel and retries on not_in_channel', async () => {
    slack.postMessage.mockRejectedValueOnce(new Error('Slack API error: not_in_channel'));
    await call('POST', '/api/5e2f9a41/bids', bid);
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.joinChannel).toHaveBeenCalledWith('xoxb-test', 'C0CKXTAMWQY');
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
  });

  test('with bid-limits-v2 off the bid is accepted and limits still apply', async () => {
    service.FLAGS[FLAG] = false;
    const ok = await call('POST', '/api/5e2f9a41/bids', bid);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('ACCEPTED');
    expect(service.getAuctions().bids).toHaveLength(1);
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 5000 })).body.code).toBe('OVER_LIMIT');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, yieldPct: 9 })).body.code).toBe('YIELD_OUT_OF_BAND');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 1.5 })).body.code).toBe('INVALID_INCREMENT');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, yieldPct: 4.4125 })).body.code).toBe('INVALID_INCREMENT');
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 750 })).status).toBe(201);
    expect((await call('POST', '/api/5e2f9a41/bids', { ...bid, nominalMn: 1 })).body.code).toBe('OVER_LIMIT');
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});

describe('Contact Support -> #bloomberg-feedback', () => {
  const report = {
    category: 'Bid submission', title: 'Bid not accepted for UKT 4 1/4 07/31/34',
    description: 'Submit bid returns an error before the close of bidding.', page: '/bloomberg-auctions', reference: 'AUC-1A2B3C4D',
  };
  const post = (body) => call('POST', service.FEEDBACK_ROUTE, body);

  test('page has the support dialog and config names the channel', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5e2f9a41.html'), 'utf8');
    expect(html).toContain('id="support-open"');
    expect(html).toContain("API + '/feedback'");
    expect((await call('GET', `${service.API_BASE}/config`)).body).toMatchObject({ feedbackChannel: '#bloomberg-feedback', feedbackMode: 'live' });
  });

  test('rejects invalid tickets without posting', async () => {
    const bad = await Promise.all([
      post({ ...report, category: 'Nope' }), post({ ...report, title: 'ab' }), post({ ...report, description: 'short' }),
      post({ ...report, page: 'https://evil.example/' }), post({ ...report, reference: '<@U1>' }), post({}),
    ]);
    bad.forEach((res) => expect(res).toMatchObject({ status: 400, body: { code: 'FEEDBACK_REJECTED' } }));
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('dry-run without a Slack token', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const res = await post(report);
    expect(res.body).toMatchObject({ status: 'dry-run', channel: '#bloomberg-feedback' });
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('posts plain-text blocks to #bloomberg-feedback, never #bloomberg-oncall, and raises no incident', async () => {
    const res = await post({ ...report, title: 'Second <b>report</b> *markup*' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'sent', channel: '#bloomberg-feedback', ticketId: expect.stringMatching(/^SUP-[0-9A-F]{8}$/) });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text, blocks] = slack.postMessage.mock.calls[0];
    expect(channel).toBe('C0CK7T5DD3N');
    expect(text).not.toContain('markup');
    blocks.forEach((b) => expect((b.text || b.elements[0]).type).toBe('plain_text'));
    expect(JSON.stringify(blocks)).toContain('AUC-1A2B3C4D');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('refuses the on-call channel, rate-limits, and reports delivery failure', async () => {
    process.env.SLACK_BLOOMBERG_FEEDBACK_CHANNEL_ID = 'C0CKXTAMWQY';
    expect((await post(report)).status).toBe(503);
    delete process.env.SLACK_BLOOMBERG_FEEDBACK_CHANNEL_ID;
    service.resetFeedbackState();
    slack.postMessage.mockRejectedValueOnce(new Error('Slack API error: channel_not_found'));
    expect((await post(report)).status).toBe(502);
    for (let i = 0; i < 4; i += 1) expect((await post(report)).status).toBe(200);
    expect((await post(report)).status).toBe(429);
  });
});

describe('bloomberg-feature-flag MCP stand-in', () => {
  const rpc = (method, params) => call('POST', flagMcp.MCP_PATH, { jsonrpc: '2.0', id: 1, method, params });
  const tool = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).body.result.content[0].text);

  test('initializes and lists the four tools', async () => {
    expect((await rpc('initialize', { protocolVersion: '2025-06-18' })).body.result.serverInfo.name).toBe('bloomberg-feature-flag');
    const tools = (await rpc('tools/list')).body.result.tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_flags', 'get_flag', 'set_flag', 'disable_flag']));
  });

  test('shows bid-limits-v2 enabled in prod by the release pipeline', async () => {
    const flag = await tool('get_flag', { flagKey: FLAG });
    expect(flag.environments.prod).toMatchObject({ enabled: true, rolloutPercent: 100, previous: { enabled: false } });
    expect(flag.service).toBe(service.SERVICE);
  });

  test('disable_flag returns a change record and does not persist it', async () => {
    const change = await tool('disable_flag', { flagKey: FLAG, reason: 'bid submission outage' });
    expect(change.status).toBe('applied');
    expect(change.change.to).toEqual({ enabled: false, rolloutPercent: 0 });
    expect((await tool('get_flag', { flagKey: FLAG })).environments.prod.enabled).toBe(true);
  });

  test('GET is 405', async () => {
    expect((await call('GET', flagMcp.MCP_PATH)).status).toBe(405);
  });
});

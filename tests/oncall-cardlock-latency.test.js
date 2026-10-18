jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue('U0CARDLOCK'),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-cardlock',
    url: 'https://app.devin.ai/sessions/session-cardlock',
  }),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');
const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { CARDLOCK, isCardLockReport, normalizeReport, getLockLatencyStatus } = require('../app/services/oncall-verticals/cardlock');
const router = require('../app/routes/oncall');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.DEVIN_ONCALL_ORG_ID = 'org_test';

const REPORT = {
  source: 'card-controls-mobile/ios',
  service: 'card-controls-mobile',
  release: 'card-controls-mobile@1.2.3',
  screen: 'erica',
  action: 'lock_card',
  cardLast4: '4417',
  cardType: 'debit',
  durationMs: 10214,
  sloMs: 3000,
  requestCount: 40,
  merchantCount: 38,
  spans: [
    { name: 'card_controls.recurring_merchants', count: 1, totalMs: 10004 },
    { name: 'card_controls.merchant_status', count: 38, totalMs: 203 },
    { name: 'card_controls.lock', count: 1, totalMs: 7 },
  ],
  device: 'iPhone 17',
  osVersion: 'iOS 19.0',
  devinEmail: 'presenter@example.com',
};

function request(server, method, path, body, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const PATH = `/api/oncall/${CARDLOCK.slug}/lock-latency`;

describe('Card lock latency report (e91b0f39)', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1', done);
  });

  afterAll(() => new Promise((resolve) => server.close(() => resolve())));

  beforeEach(() => jest.clearAllMocks());

  async function postAndWait(report) {
    const response = await request(server, 'POST', PATH, report);
    expect(response.status).toBe(202);
    const { reference, statusToken } = response.body;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (getLockLatencyStatus(reference, statusToken)?.done) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
  }

  test.each(['ios', 'android'])('%s report creates one alert and one orchestrator session for both repos', async (platform) => {
    const response = await postAndWait({ ...REPORT, source: `card-controls-mobile/${platform}` });

    expect(response.body).toMatchObject({
      received: true,
      service: CARDLOCK.service,
      sessionRequested: true,
    });
    expect(response.body.reference).toMatch(/^CL-[0-9a-f]{6}$/);
    expect(response.body.statusToken).toMatch(/^[0-9a-f]{32}$/);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [token, channel, text, blocks] = postMessage.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe('C0TEST');
    expect(text).toContain('card-controls-mobile (Bank of America mobile (Erica))');
    expect(text).toContain(`Incident Ref:* ${response.body.reference}`);
    expect(text).toContain('erica → lock_card (debit ••4417)');
    expect(text).toContain('10,214 ms (SLO 3,000 ms)');
    expect(text).toContain('40 card-controls calls');
    expect(text).toContain('card_controls.recurring_merchants ×1 — 10004 ms');
    expect(text).toContain('`card_lock.duration_ms <= slo_ms` — failed on device');
    expect(text).toContain('https://github.com/COG-GTM/ios-demos (apps/e91b0f39)');
    expect(text).toContain('https://github.com/COG-GTM/android-demos (apps/e91b0f39)');
    expect(text).toContain('Triggered by:* <@U0CARDLOCK>');
    expect(blocks[0].type).toBe('header');
    expect(JSON.stringify(blocks)).toContain('card-controls-mobile');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({
      orgId: 'org_test',
      platform: 'linux',
      repos: ['COG-GTM/ios-demos', 'COG-GTM/android-demos'],
      title: `[On-Call] ${response.body.reference} Card lock latency above SLO (card-controls-mobile)`,
    });
    expect(prompt).toContain(`*Incident Ref:* ${response.body.reference}`);
    expect(prompt).toContain('You are the ORCHESTRATOR');
    expect(prompt).toContain('a *macOS* child for COG-GTM/ios-demos');
    expect(prompt).toContain('a *Linux* child for COG-GTM/android-demos');
    expect(prompt).toContain('[DEMO — DO NOT MERGE]');
    expect(prompt).not.toContain('You are on macOS');
    expect(prompt).not.toContain('Create ONE Linux child');
    expect(prompt).toContain('card_controls.recurring_merchants ×1 = 10004 ms');
    expect(prompt).toContain('https://github.com/COG-GTM/ios-demos');
    expect(prompt).toContain('https://github.com/COG-GTM/android-demos');
    expect(prompt).toContain('*Slack Thread:* channel=C0TEST thread_ts=1700000000.000100');
    expect(prompt).not.toMatch(/(?:^|[\s/])(?:App|src)\//);
    expect(prompt).not.toContain('presenter@example.com');

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test',
      'C0TEST',
      '1700000000.000100',
      expect.stringContaining('https://app.devin.ai/sessions/session-cardlock'),
      expect.any(Array),
    );
    expect(postThreadReply.mock.calls[0][4][0].text.text).toContain(
      '(orchestrator — macOS child for COG-GTM/ios-demos, Linux child for COG-GTM/android-demos)',
    );
  });

  test('normalizes bounds, defaults, clipped device details, and valid spans', () => {
    const report = normalizeReport({
      ...REPORT,
      source: 'card-controls-mobile/android',
      requestCount: undefined,
      merchantCount: undefined,
      spans: [
        { name: 'valid_span', count: 0, totalMs: 0 },
        { name: 'INVALID', count: 2, totalMs: 3 },
        { name: 'bad_count', count: 1001, totalMs: 3 },
        ...Array.from({ length: 7 }, (_, i) => ({ name: `span_${i}`, count: i, totalMs: i })),
      ],
      device: 'D'.repeat(50),
      osVersion: 'V'.repeat(30),
    });
    expect(report).toMatchObject({
      platform: 'android',
      platformLabel: 'Android',
      requestCount: null,
      merchantCount: null,
      screen: 'erica',
      action: 'lock_card',
      release: 'card-controls-mobile@1.2.3',
    });
    expect(report.spans).toHaveLength(6);
    expect(report.device).toHaveLength(40);
    expect(report.osVersion).toHaveLength(20);
    expect(normalizeReport({ ...REPORT, sloMs: undefined }).sloMs).toBe(3000);
    expect(normalizeReport({ ...REPORT, sloMs: 500 }).sloMs).toBe(3000);
    expect(normalizeReport({ ...REPORT, cardType: undefined }).cardType).toBe('debit');
    expect(normalizeReport({ ...REPORT, reportId: 'bad id' }).reportId).toBeNull();
  });

  test('rejects healthy durations and invalid report identity or card facts', async () => {
    expect((await request(server, 'POST', PATH, { ...REPORT, durationMs: 3000 })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, durationMs: 2999 })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, durationMs: 800, sloMs: 500 })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, source: 'other/ios' })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, service: 'other' })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, cardLast4: '12x4' })).status).toBe(400);
    const tooManySpans = Array.from({ length: 21 }, (_, i) => ({ name: `span_${i}`, count: 1, totalMs: 1 }));
    expect(normalizeReport({ ...REPORT, spans: tooManySpans })).toBeNull();
    expect((await request(server, 'POST', PATH, { ...REPORT, spans: tooManySpans })).status).toBe(400);
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('uses the card type in the prompt', async () => {
    await postAndWait({ ...REPORT, cardType: 'credit' });

    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('erica → lock_card (credit card ending 4417)');
    expect(prompt).not.toContain('debit card ending');
    expect(postMessage.mock.calls[0][2]).toContain('erica → lock_card (credit ••4417)');
  });

  test('deduplicates valid reportIds without posting another alert or session', async () => {
    const report = { ...REPORT, reportId: 'lock-retry-0001' };
    const first = await postAndWait(report);
    const duplicate = await request(server, 'POST', PATH, report);

    expect(duplicate.status).toBe(202);
    expect(duplicate.body.reference).toBe(first.body.reference);
    expect(duplicate.body.statusToken).toBeNull();
    expect(duplicate.body.statusToken).not.toBe(first.body.statusToken);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });

  test('status requires the token and the fallback alert text includes the responder skip marker', async () => {
    const report = normalizeReport(REPORT);
    const { reference, statusToken, outcome } = require('../app/services/oncall-verticals/cardlock').reportLockLatency(report);
    await outcome;

    expect(getLockLatencyStatus(reference)).toBeNull();
    expect(getLockLatencyStatus(reference, '0'.repeat(32))).toBeNull();
    expect(getLockLatencyStatus(reference, statusToken)).toMatchObject({
      reference,
      service: CARDLOCK.service,
      alertPosted: true,
      done: true,
    });

    const text = postMessage.mock.calls[0][2];
    expect(text).toContain('card-controls-mobile');
    expect((await request(server, 'GET', `${PATH}/${reference}`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/${reference}`, undefined, {
      'x-status-token': statusToken,
    })).status).toBe(200);
  });

  test('isCardLockReport accepts only the two native source platforms and service', () => {
    expect(isCardLockReport(REPORT)).toBe(true);
    expect(isCardLockReport({ ...REPORT, source: 'card-controls-mobile/android' })).toBe(true);
    expect(isCardLockReport({ ...REPORT, source: 'card-controls-mobile/web' })).toBe(false);
    expect(isCardLockReport({ ...REPORT, service: 'other' })).toBe(false);
    expect(isCardLockReport(null)).toBe(false);
  });
});

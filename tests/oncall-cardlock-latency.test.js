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

jest.mock('../app/telemetry/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
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
const logger = require('../app/telemetry/logger');
const {
  CARDLOCK,
  isCardLockReport,
  normalizeReport,
  datadogLogsQuery,
  datadogLogsUrl,
  getLockLatencyStatus,
} = require('../app/services/oncall-verticals/cardlock');
const router = require('../app/routes/oncall');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.DEVIN_ONCALL_ORG_ID = 'org_test';
process.env.DD_SITE = 'us5.datadoghq.com';

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

  test.each(['ios', 'android'])('%s report creates one alert and one orchestrator session for all three client repos', async (platform) => {
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
    expect(text).not.toContain('*Requests:*');
    expect(text).not.toContain('*Spans:*');
    expect(text).toContain('`card_lock.duration_ms <= slo_ms` — failed on device');
    expect(text).toContain('https://github.com/COG-GTM/ios-demos (apps/e91b0f39)');
    expect(text).toContain('https://github.com/COG-GTM/android-demos (apps/e91b0f39)');
    expect(text).toContain('https://github.com/COG-GTM/event-driven-devin (app/public/verticals/e91b0f39/)');
    expect(text).toContain('Triggered by:* <@U0CARDLOCK>');
    expect(blocks[0].type).toBe('header');
    expect(JSON.stringify(blocks)).toContain('card-controls-mobile');
    expect(JSON.stringify(blocks)).not.toContain('Requests');
    expect(JSON.stringify(blocks)).not.toContain('*Spans:*');
    const datadogButton = blocks.find((block) => block.type === 'actions')?.elements[0];
    expect(datadogButton).toMatchObject({
      type: 'button',
      text: { type: 'plain_text', text: 'View logs in Datadog', emoji: true },
    });
    expect(datadogButton.url).toContain('https://app.us5.datadoghq.com/logs?query=');
    expect(new URL(datadogButton.url).searchParams.get('query')).toBe(
      `@slug:${CARDLOCK.slug} @reference:${response.body.reference}`,
    );

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({
      orgId: 'org_test',
      platform: 'linux',
      repos: ['COG-GTM/ios-demos', 'COG-GTM/android-demos', 'COG-GTM/event-driven-devin'],
      title: `[On-Call] ${response.body.reference} Card lock latency above SLO (card-controls-mobile)`,
    });
    expect(CARDLOCK.repos).toEqual([
      'COG-GTM/ios-demos',
      'COG-GTM/android-demos',
      'COG-GTM/event-driven-devin',
    ]);
    expect(prompt).toContain(`*Incident Ref:* ${response.body.reference}`);
    expect(prompt).toContain(`@slug:${CARDLOCK.slug} @reference:${response.body.reference}`);
    expect(prompt).toContain('search_datadog_logs');
    expect(prompt).toContain('https://app.us5.datadoghq.com/logs?query=');
    expect(prompt).not.toContain('*Spans:*');
    expect(prompt).not.toContain('*Requests during the lock:*');
    expect(prompt).toContain('You are the ORCHESTRATOR');
    expect(prompt).toContain('a *macOS* child for COG-GTM/ios-demos');
    expect(prompt).toContain('a *Linux* child for COG-GTM/android-demos');
    expect(prompt).toContain('a *Linux* child for COG-GTM/event-driven-devin');
    expect(prompt).toContain('Create THREE child Devin sessions in parallel');
    expect(prompt).toContain('app/public/verticals/e91b0f39/');
    expect(prompt).toContain('npx jest tests/e91b0f39-web-card-controls.test.js');
    expect(prompt).toContain('http://localhost:<port>/e91b0f39?reports=off');
    expect(prompt).toContain('LOCK_TIMEOUT_MS = 10000');
    expect(prompt).toContain('Something went wrong. Request timed out');
    expect(prompt).toContain('under 3 s');
    expect(prompt).toContain('[DEMO — DO NOT MERGE]');
    expect(prompt).not.toContain('You are on macOS');
    expect(prompt).not.toContain('Create ONE Linux child');
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
      '(orchestrator — macOS child for ios-demos, Linux children for android-demos and web)',
    );
  });

  test('accepts web reports and labels the alert and prompt as Web', async () => {
    const response = await postAndWait({
      ...REPORT,
      source: 'card-controls-web/desktop',
      service: 'card-controls-web',
      release: 'card-controls-web@1.2.3',
    });

    expect(response.body).toMatchObject({
      received: true,
      service: 'card-controls-web',
      platform: 'web',
      sessionRequested: true,
    });
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('card-controls-web (Web)');
    expect(text).toContain('Bank of America Online Banking (Erica)');
    expect(text).toContain('(Web)');
    expect(JSON.stringify(blocks)).toContain('Web');
    expect(JSON.stringify(blocks)).toContain('card-controls-web');

    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('from the Web client');
    expect(prompt).toContain('a *Linux* child for COG-GTM/event-driven-devin');
    expect(prompt).toContain('app/public/verticals/e91b0f39/');
    expect(options.repos).toEqual(CARDLOCK.repos);
  });

  test('includes timeout outcome in logs, alerts, and prompt impact', async () => {
    await postAndWait({ ...REPORT, durationMs: 10000, outcome: 'timeout' });

    const breachLog = logger.error.mock.calls
      .find(([message]) => message === 'Card lock latency SLO breach reported');
    expect(breachLog[1]).toMatchObject({ outcome: 'timeout' });

    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('*Outcome:* Timed out');
    const outcomeField = blocks
      .flatMap((block) => block.fields || [])
      .find((field) => field.text.startsWith('*Outcome:*'));
    expect(outcomeField.text).toBe('*Outcome:*\nTimed out');

    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('*Outcome:* Timed out');
    expect(prompt).toContain('Customers see a spinner for ~10 s and then "Something went wrong. Request timed out"; the card is not locked.');
  });

  test('logs accepted breach details and one Datadog record per normalized span', async () => {
    const spans = [
      ...REPORT.spans,
      { name: 'card_controls.empty_span', count: 0, totalMs: 0 },
    ];
    const response = await postAndWait({
      ...REPORT,
      spans,
      reportId: 'card-lock-log-test',
    });
    const breachLogs = logger.error.mock.calls.filter(([message]) => message === 'Card lock latency SLO breach reported');
    expect(breachLogs).toHaveLength(1);
    expect(breachLogs[0][1]).toMatchObject({
      reference: response.body.reference,
      check: CARDLOCK.check,
      slug: CARDLOCK.slug,
      platform: 'ios',
      source: 'card-controls-mobile/ios',
      release: REPORT.release,
      device: REPORT.device,
      osVersion: REPORT.osVersion,
      cardType: REPORT.cardType,
      cardLast4: REPORT.cardLast4,
      durationMs: REPORT.durationMs,
      sloMs: 3000,
      requestCount: REPORT.requestCount,
      merchantCount: REPORT.merchantCount,
      reportId: 'card-lock-log-test',
      spans: spans.map((span) => ({
        name: span.name,
        count: span.count,
        totalMs: span.totalMs,
        avgMs: span.count > 0 ? Math.round(span.totalMs / span.count) : null,
      })),
    });

    const spanLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Card lock client span')
      .map(([, fields]) => fields);
    expect(spanLogs).toEqual([
      {
        reference: response.body.reference,
        check: CARDLOCK.check,
        slug: CARDLOCK.slug,
        platform: 'ios',
        release: REPORT.release,
        span: 'card_controls.recurring_merchants',
        count: 1,
        totalMs: 10004,
        avgMs: 10004,
      },
      {
        reference: response.body.reference,
        check: CARDLOCK.check,
        slug: CARDLOCK.slug,
        platform: 'ios',
        release: REPORT.release,
        span: 'card_controls.merchant_status',
        count: 38,
        totalMs: 203,
        avgMs: 5,
      },
      {
        reference: response.body.reference,
        check: CARDLOCK.check,
        slug: CARDLOCK.slug,
        platform: 'ios',
        release: REPORT.release,
        span: 'card_controls.lock',
        count: 1,
        totalMs: 7,
        avgMs: 7,
      },
      {
        reference: response.body.reference,
        check: CARDLOCK.check,
        slug: CARDLOCK.slug,
        platform: 'ios',
        release: REPORT.release,
        span: 'card_controls.empty_span',
        count: 0,
        totalMs: 0,
        avgMs: null,
      },
    ]);
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
      service: 'card-controls-mobile',
      outcome: 'success',
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
    expect((await request(server, 'POST', PATH, {
      ...REPORT,
      source: 'card-controls-web/desktop',
    })).status).toBe(400);
    expect((await request(server, 'POST', PATH, {
      ...REPORT,
      service: 'card-controls-web',
    })).status).toBe(400);
    expect((await request(server, 'POST', PATH, { ...REPORT, outcome: 'failed' })).status).toBe(400);
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
    const logCountsBeforeDuplicate = {
      error: logger.error.mock.calls.length,
      info: logger.info.mock.calls.length,
      warn: logger.warn.mock.calls.length,
    };
    const duplicate = await request(server, 'POST', PATH, report);

    expect(duplicate.status).toBe(202);
    expect(duplicate.body.reference).toBe(first.body.reference);
    expect(duplicate.body.statusToken).toBeNull();
    expect(duplicate.body.statusToken).not.toBe(first.body.statusToken);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect({
      error: logger.error.mock.calls.length,
      info: logger.info.mock.calls.length,
      warn: logger.warn.mock.calls.length,
    }).toEqual(logCountsBeforeDuplicate);
  });

  test('deduplicates reportIds independently by source', async () => {
    const reportId = 'cross-source-0001';
    const mobile = await postAndWait({ ...REPORT, reportId });
    const web = await postAndWait({
      ...REPORT,
      source: 'card-controls-web/desktop',
      service: 'card-controls-web',
      release: 'card-controls-web@1.2.3',
      reportId,
    });

    expect(mobile.body.reference).not.toBe(web.body.reference);
    expect(web.body).toMatchObject({
      service: 'card-controls-web',
      platform: 'web',
      sessionRequested: true,
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(createDevinSession).toHaveBeenCalledTimes(2);
  });

  test('builds an encoded Datadog URL with a fifteen-minute window around the report', () => {
    const reference = 'CL-12ab34';
    const reportedAtMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    const query = `@slug:${CARDLOCK.slug} @reference:${reference}`;
    const url = datadogLogsUrl(reference, reportedAtMs);
    const parsed = new URL(url);

    expect(datadogLogsQuery(reference)).toBe(query);
    expect(url).toContain(`query=${encodeURIComponent(query)}`);
    expect(parsed.origin).toBe('https://app.us5.datadoghq.com');
    expect(parsed.pathname).toBe('/logs');
    expect(parsed.searchParams.get('query')).toBe(query);
    expect(parsed.searchParams.get('from_ts')).toBe(String(reportedAtMs - 15 * 60 * 1000));
    expect(parsed.searchParams.get('to_ts')).toBe(String(reportedAtMs + 15 * 60 * 1000));
    expect(parsed.searchParams.get('live')).toBe('false');
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

  test('isCardLockReport accepts only configured source and service pairs', () => {
    expect(isCardLockReport(REPORT)).toBe(true);
    expect(isCardLockReport({ ...REPORT, source: 'card-controls-mobile/android' })).toBe(true);
    expect(isCardLockReport({
      ...REPORT,
      source: 'card-controls-web/desktop',
      service: 'card-controls-web',
    })).toBe(true);
    expect(isCardLockReport({ ...REPORT, source: 'card-controls-mobile/web' })).toBe(false);
    expect(isCardLockReport({ ...REPORT, source: 'card-controls-web/desktop' })).toBe(false);
    expect(isCardLockReport({ ...REPORT, service: 'other' })).toBe(false);
    expect(isCardLockReport(null)).toBe(false);
  });

  test('retains the breach span breakdown when the real logger level is error', async () => {
    const previousLogLevel = process.env.LOG_LEVEL;
    const records = [];
    let isolatedLogger;
    let loggerSpy;
    let isolatedReportLockLatency;

    try {
      process.env.LOG_LEVEL = 'error';
      jest.unmock('../app/telemetry/logger');
      jest.isolateModules(() => {
        isolatedLogger = require('../app/telemetry/logger');
        loggerSpy = jest.spyOn(isolatedLogger.transports[0], 'log').mockImplementation((info, callback) => {
          records.push(info);
          if (callback) callback();
        });
        ({ reportLockLatency: isolatedReportLockLatency } = require('../app/services/oncall-verticals/cardlock'));
      });

      expect(isolatedLogger.level).toBe('error');
      isolatedReportLockLatency(normalizeReport(REPORT));
      await new Promise((resolve) => setImmediate(resolve));

      const breachRecord = records.find((record) => record.message === 'Card lock latency SLO breach reported');
      expect(breachRecord.spans).toEqual(REPORT.spans.map((span) => ({
        name: span.name,
        count: span.count,
        totalMs: span.totalMs,
        avgMs: Math.round(span.totalMs / span.count),
      })));
    } finally {
      if (loggerSpy) loggerSpy.mockRestore();
      if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLogLevel;
    }
  });
});

jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue('U0PARTY'),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-partiful',
    url: 'https://app.devin.ai/sessions/session-partiful',
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
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.DEVIN_ONCALL_ORG_ID = 'org_test';

const {
  PARTIFUL,
  isPartifulReport,
  normalizeReport,
  reportRsvpPageFailure,
  getRsvpPageFailureStatus,
} = require('../app/services/oncall-verticals/partiful');
const router = require('../app/routes/oncall');

const REPORT = {
  source: 'partiful-rsvp/ios',
  service: 'partiful-rsvp',
  release: 'partiful-rsvp@1.1.0',
  eventId: 'pasta-night-mine',
  eventTitle: 'Pasta Night @ Mine',
  host: 'Mara Quintero',
  theme: 'Marquee',
  screen: 'event',
  action: 'open_rsvp_page',
  reason: 'missing_cover_photo',
  invitedCount: 14,
  goingCount: 6,
  shareLink: 'https://partiful.com/e/pasta-night-mine',
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

const PATH = `/api/oncall/${PARTIFUL.slug}/rsvp-page-failure`;

describe('Partiful RSVP page failure report (205bc15f)', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1', done);
  });

  afterAll(() => new Promise((resolve) => server.close(() => resolve())));

  beforeEach(() => jest.clearAllMocks());

  test('only partiful-rsvp/<ios|macos> sources with the partiful service are reports', () => {
    expect(isPartifulReport(REPORT)).toBe(true);
    expect(isPartifulReport({ ...REPORT, source: 'partiful-rsvp/macos' })).toBe(true);
    expect(isPartifulReport({ ...REPORT, source: 'partiful-rsvp/web' })).toBe(false);
    expect(isPartifulReport({ ...REPORT, service: 'fleet-mobile' })).toBe(false);
    expect(isPartifulReport(null)).toBe(false);
  });

  test('normalizeReport keeps bounded facts and strips Slack markup', () => {
    const report = normalizeReport({
      ...REPORT,
      eventTitle: '<!channel> Pasta Night at <https://evil.example|Mine> & `co`'.padEnd(200, 'x'),
      release: 'not a release!',
      screen: 'event; drop',
      invitedCount: -3,
      goingCount: 1.5,
    });
    expect(report.platformLabel).toBe('iOS');
    expect(report.eventId).toBe('pasta-night-mine');
    expect(report.eventTitle).not.toMatch(/[<>&|`]/);
    expect(report.eventTitle.length).toBeLessThanOrEqual(80);
    expect(report.release).toBe('partiful-rsvp@unknown');
    expect(report.screen).toBe('event');
    expect(report.invitedCount).toBeNull();
    expect(report.goingCount).toBeNull();
    expect(report.devinEmail).toBe('presenter@example.com');
  });

  test('normalizeReport rejects unknown reason codes and malformed event ids', () => {
    expect(normalizeReport({ ...REPORT, reason: 'because' })).toBeNull();
    expect(normalizeReport({ ...REPORT, reason: 'toString' })).toBeNull();
    expect(normalizeReport({ ...REPORT, reason: undefined })).toBeNull();
    expect(normalizeReport({ ...REPORT, eventId: 'Pasta Night' })).toBeNull();
    expect(normalizeReport({ ...REPORT, eventId: '../../etc/passwd' })).toBeNull();
    expect(normalizeReport(null)).toBeNull();
  });

  test('normalizeReport only keeps an https partiful.com invite link', () => {
    expect(normalizeReport(REPORT).shareLink).toBe('https://partiful.com/e/pasta-night-mine');
    expect(normalizeReport({ ...REPORT, shareLink: 'https://evil.example/e/x' }).shareLink).toBeNull();
    expect(normalizeReport({ ...REPORT, shareLink: 'javascript:alert(1)' }).shareLink).toBeNull();
    expect(normalizeReport({ ...REPORT, shareLink: 'not a url' }).shareLink).toBeNull();
  });

  test('a report posts one alert, creates one macOS session on ios-demos and links it in the thread', async () => {
    const { reference, statusToken, outcome } = reportRsvpPageFailure(normalizeReport(REPORT));
    expect(reference).toMatch(/^PTF-[0-9a-f]{6}$/);
    expect(statusToken).toMatch(/^[0-9a-f]{32}$/);

    const entry = await outcome;

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [token, channel, text, blocks] = postMessage.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe('C0TEST');
    expect(text).toContain('partiful-rsvp');
    expect(text).toContain(`Incident Ref:* ${reference}`);
    expect(text).toContain('Pasta Night @ Mine');
    expect(text).toContain('14 invited · 6 going');
    expect(text).toContain('Triggered by:* <@U0PARTY>');
    expect(text).toContain('github.com/COG-GTM/ios-demos');
    expect(blocks[0].type).toBe('header');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({
      orgId: 'org_test',
      platform: 'macos',
      repos: ['COG-GTM/ios-demos'],
    });
    expect(options.title).toContain(reference);
    expect(prompt).toContain('apps/205bc15f');
    expect(prompt).toContain('make run');
    expect(prompt).toContain('make test');
    expect(prompt).toContain('pasta-night-mine');
    expect(prompt).not.toMatch(/\.swift|EventPageService|coverPhoto/);
    expect(prompt).not.toContain('presenter@example.com');

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test',
      'C0TEST',
      '1700000000.000100',
      expect.stringContaining('https://app.devin.ai/sessions/session-partiful'),
      expect.any(Array),
    );

    expect(entry.done).toBe(true);
    expect(getRsvpPageFailureStatus(reference, statusToken)).toEqual({
      reference,
      service: 'partiful-rsvp',
      alertPosted: true,
      sessionUrl: 'https://app.devin.ai/sessions/session-partiful',
      done: true,
      error: null,
    });
  });

  test('a failed Slack post still creates the session and records the error', async () => {
    postMessage.mockRejectedValueOnce(new Error('slack down'));
    const { reference, statusToken, outcome } = reportRsvpPageFailure(normalizeReport(REPORT));
    await outcome;

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(getRsvpPageFailureStatus(reference, statusToken)).toMatchObject({
      alertPosted: false, sessionUrl: expect.any(String), done: true, error: 'alert failed',
    });
  });

  test('status requires the token handed to the reporting device; the reference alone is not enough', async () => {
    const { reference, statusToken, outcome } = reportRsvpPageFailure(normalizeReport(REPORT));
    await outcome;
    expect(getRsvpPageFailureStatus(reference)).toBeNull();
    expect(getRsvpPageFailureStatus(reference, 'nope')).toBeNull();
    expect(getRsvpPageFailureStatus(reference, '0'.repeat(32))).toBeNull();
    expect(getRsvpPageFailureStatus(reference, statusToken)).toMatchObject({ reference });
  });

  test('a report emits a Datadog metric and a Sentry event tagged with the on-call route', async () => {
    const { reference, outcome } = reportRsvpPageFailure(normalizeReport(REPORT));
    await outcome;
    expect(incrementMetric).toHaveBeenCalledWith('partiful_rsvp.page_failure', expect.objectContaining({
      route: '/api/oncall/205bc15f/rsvp-page-failure', platform: 'ios', reason: 'missing_cover_photo',
    }));
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = Sentry.captureMessage.mock.calls[0];
    expect(message).toContain('partiful-rsvp/ios');
    expect(context.tags).toMatchObject({ route: '/api/oncall/205bc15f/rsvp-page-failure', service: 'partiful-rsvp' });
    expect(context.extra).toMatchObject({ reference, eventId: 'pasta-night-mine' });
    expect(JSON.stringify(context)).not.toContain('presenter@example.com');
  });

  test('reportRsvpPageFailure ignores anything but a normalized report', () => {
    expect(reportRsvpPageFailure(null)).toBeNull();
    expect(reportRsvpPageFailure(REPORT)).toBeNull();
  });

  test('POST acknowledges with 202 and a reference; GET exposes the outcome', async () => {
    const response = await request(server, 'POST', PATH, REPORT);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      received: true,
      service: 'partiful-rsvp',
      sessionRequested: true,
    });
    const { reference, statusToken } = response.body;
    expect(reference).toMatch(/^PTF-[0-9a-f]{6}$/);
    expect(statusToken).toMatch(/^[0-9a-f]{32}$/);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect((await request(server, 'GET', `${PATH}/${reference}`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/${reference}`, undefined, { 'x-status-token': 'f'.repeat(32) })).status).toBe(404);
    // The token travels in a header only: a query string would land in access logs.
    expect((await request(server, 'GET', `${PATH}/${reference}?token=${statusToken}`)).status).toBe(404);

    const status = await request(server, 'GET', `${PATH}/${reference}`, undefined, { 'x-status-token': statusToken });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ reference, alertPosted: true });
    expect(status.body).not.toHaveProperty('statusToken');
    expect(status.body).not.toHaveProperty('devinEmail');
  });

  test('POST rejects foreign sources and malformed facts', async () => {
    const foreign = await request(server, 'POST', PATH, { ...REPORT, source: 'fleet-mobile/ios' });
    expect(foreign.status).toBe(400);
    expect(postMessage).not.toHaveBeenCalled();

    const malformed = await request(server, 'POST', PATH, { ...REPORT, reason: 'vibes' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.received).toBe(false);
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('malformed POSTs do not consume the hourly trigger cap', async () => {
    for (let i = 0; i < 60; i += 1) {
      const bad = await request(server, 'POST', PATH, { ...REPORT, reason: 'vibes' });
      expect(bad.status).toBe(400);
    }
    const good = await request(server, 'POST', PATH, REPORT);
    expect(good.status).toBe(202);
  });

  test('GET rejects unknown or malformed references', async () => {
    expect((await request(server, 'GET', `${PATH}/PTF-000000`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/..%2Fetc`)).status).toBe(404);
  });
});

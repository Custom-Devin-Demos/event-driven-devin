jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue('U0FLEET'),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-fleet',
    url: 'https://app.devin.ai/sessions/session-fleet',
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

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.DEVIN_ONCALL_ORG_ID = 'org_test';

const {
  FLEET,
  isFleetReport,
  normalizeReport,
  reportEtaFailure,
  getEtaFailureStatus,
} = require('../app/services/oncall-verticals/fleet');
const router = require('../app/routes/oncall');

const REPORT = {
  source: 'fleet-mobile/ios',
  service: 'fleet-mobile',
  release: 'fleet-mobile@1.1.0',
  orgId: '36211',
  assetId: '224221',
  driver: 'Travis Smith',
  routeName: 'Route to Hardy\u2019s',
  destination: 'Hardy\u2019s Market',
  screen: 'asset',
  action: 'share_live_eta',
  departure: '2026-09-14T23:20:00Z',
  arrival: '2026-09-14T23:20:00Z',
  timeZone: 'America/Los_Angeles',
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

const PATH = `/api/oncall/${FLEET.slug}/eta-failure`;

describe('Fleet mobile ETA failure report (26a3d261)', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1', done);
  });

  afterAll(() => new Promise((resolve) => server.close(() => resolve())));

  beforeEach(() => jest.clearAllMocks());

  test('only fleet-mobile/<ios|macos> sources with the fleet service are reports', () => {
    expect(isFleetReport(REPORT)).toBe(true);
    expect(isFleetReport({ ...REPORT, source: 'fleet-mobile/macos' })).toBe(true);
    expect(isFleetReport({ ...REPORT, source: 'fleet-mobile/web' })).toBe(false);
    expect(isFleetReport({ ...REPORT, service: 'checkout-api' })).toBe(false);
    expect(isFleetReport(null)).toBe(false);
  });

  test('normalizeReport keeps bounded facts and strips Slack markup', () => {
    const report = normalizeReport({
      ...REPORT,
      routeName: '<!channel> Route to <https://evil.example|Hardy\u2019s> & `co`'.padEnd(200, 'x'),
      release: 'not a release!',
      screen: 'asset; drop',
      orgId: 'abc',
    });
    expect(report.platformLabel).toBe('iOS');
    expect(report.assetId).toBe('224221');
    expect(report.minutesOut).toBe(0);
    expect(report.routeName).not.toMatch(/[<>&|`]/);
    expect(report.routeName.length).toBeLessThanOrEqual(80);
    expect(report.release).toBe('fleet-mobile@unknown');
    expect(report.screen).toBe('asset');
    expect(report.orgId).toBeNull();
    expect(report.devinEmail).toBe('presenter@example.com');
  });

  test('normalizeReport rejects reports without asset or strict ISO-8601 times', () => {
    expect(normalizeReport({ ...REPORT, assetId: 'A-1' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: 'yesterday' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: 'Sep 14 2026 16:20 PDT' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2026-09-14' })).toBeNull();
    expect(normalizeReport({ ...REPORT, arrival: undefined })).toBeNull();
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeReport({ ...REPORT, arrival: '2026-09-14T16:20:00.000-07:00' })).not.toBeNull();
  });

  test('normalizeReport rejects impossible calendar dates instead of normalising them', () => {
    expect(normalizeReport({ ...REPORT, departure: '2026-02-30T12:00:00Z', arrival: '2026-02-30T12:00:00Z' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2026-04-31T12:00:00Z', arrival: '2026-04-31T12:00:00Z' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2026-13-01T12:00:00Z', arrival: '2026-13-01T12:00:00Z' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2026-09-14T24:00:00Z', arrival: '2026-09-14T24:00:00Z' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2026-09-14T23:20:00+25:00', arrival: '2026-09-14T23:20:00+25:00' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: '2027-02-29T12:00:00Z', arrival: '2027-02-29T12:00:00Z' })).toBeNull();
    const leap = normalizeReport({ ...REPORT, departure: '2028-02-29T12:00:00Z', arrival: '2028-02-29T12:00:00Z' });
    expect(leap.departure.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    const offset = normalizeReport({ ...REPORT, departure: '2026-09-14T16:20:00-07:00', arrival: '2026-09-14T16:20:00-07:00' });
    expect(offset.departure.toISOString()).toBe('2026-09-14T23:20:00.000Z');
  });

  test('normalizeReport keeps any runtime-supported IANA zone and falls back to UTC otherwise', () => {
    expect(normalizeReport(REPORT).timeZone).toBe('America/Los_Angeles');
    expect(normalizeReport({ ...REPORT, timeZone: 'Etc/GMT+8' }).timeZone).toBe('Etc/GMT+8');
    expect(normalizeReport({ ...REPORT, timeZone: 'America/Argentina/Buenos_Aires' }).timeZone).toBe('America/Argentina/Buenos_Aires');
    expect(normalizeReport({ ...REPORT, timeZone: 'Mars/Olympus_Mons' }).timeZone).toBe('UTC');
    expect(normalizeReport({ ...REPORT, timeZone: '<!channel>' }).timeZone).toBe('UTC');
    expect(normalizeReport({ ...REPORT, timeZone: 42 }).timeZone).toBe('UTC');
  });

  test('normalizeReport rejects a healthy ETA (arrival after departure) but keeps equal or earlier arrivals', () => {
    expect(normalizeReport({ ...REPORT, arrival: '2026-09-15T00:30:00Z' })).toBeNull();
    expect(normalizeReport({ ...REPORT, arrival: '2026-09-14T23:20:00Z' })).toMatchObject({ minutesOut: 0 });
    expect(normalizeReport({ ...REPORT, arrival: '2026-09-14T23:10:00Z' })).toMatchObject({ minutesOut: -10 });
  });

  test('a report posts one alert, creates one macOS session on ios-demos and links it in the thread', async () => {
    const { reference, statusToken, outcome } = reportEtaFailure(normalizeReport(REPORT));
    expect(reference).toMatch(/^FLT-[0-9a-f]{6}$/);
    expect(statusToken).toMatch(/^[0-9a-f]{32}$/);

    const entry = await outcome;

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [token, channel, text, blocks] = postMessage.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe('C0TEST');
    expect(text).toContain('fleet-mobile');
    expect(text).toContain(`Incident Ref:* ${reference}`);
    expect(text).toContain('Asset 224221');
    expect(text).toContain('Triggered by:* <@U0FLEET>');
    expect(text).toContain('github.com/COG-GTM/ios-demos');
    expect(text).not.toMatch(/Datadog|threshold|p95/i);
    expect(blocks[0].type).toBe('header');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({
      orgId: 'org_test',
      platform: 'macos',
      repos: ['COG-GTM/ios-demos'],
    });
    expect(options.title).toContain(reference);
    expect(prompt).toContain('apps/26a3d261');
    expect(prompt).toContain('make run');
    expect(prompt).toContain('make test');
    expect(prompt).toContain('asset 224221');
    expect(prompt).toContain('2026-09-14T23:20:00.000Z');
    expect(prompt).not.toMatch(/\.swift|ETAService|ShareSummary|arrivals\.first/);
    expect(prompt).not.toContain('presenter@example.com');

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test',
      'C0TEST',
      '1700000000.000100',
      expect.stringContaining('https://app.devin.ai/sessions/session-fleet'),
      expect.any(Array),
    );

    expect(entry.done).toBe(true);
    expect(getEtaFailureStatus(reference, statusToken)).toEqual({
      reference,
      service: 'fleet-mobile',
      alertPosted: true,
      sessionUrl: 'https://app.devin.ai/sessions/session-fleet',
      done: true,
      error: null,
    });
  });

  test('a failed Slack post still creates the session and records the error', async () => {
    postMessage.mockRejectedValueOnce(new Error('slack down'));
    const { reference, statusToken, outcome } = reportEtaFailure(normalizeReport(REPORT));
    await outcome;

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(getEtaFailureStatus(reference, statusToken)).toMatchObject({
      alertPosted: false, sessionUrl: expect.any(String), done: true, error: 'alert failed',
    });
  });

  test('an unexpected pipeline failure still settles the status as done', async () => {
    lookupSlackUserByEmail.mockImplementationOnce(() => { throw new TypeError('boom'); });
    postMessage.mockImplementationOnce(() => { throw new TypeError('boom'); });
    createDevinSession.mockImplementationOnce(() => { throw new TypeError('boom'); });
    const { reference, statusToken, outcome } = reportEtaFailure(normalizeReport(REPORT));
    await outcome;
    expect(getEtaFailureStatus(reference, statusToken)).toMatchObject({ done: true, error: expect.any(String), sessionUrl: null });
  });

  test('status requires the token handed to the reporting device; the reference alone is not enough', async () => {
    const { reference, statusToken, outcome } = reportEtaFailure(normalizeReport(REPORT));
    await outcome;
    expect(getEtaFailureStatus(reference)).toBeNull();
    expect(getEtaFailureStatus(reference, 'nope')).toBeNull();
    expect(getEtaFailureStatus(reference, '0'.repeat(32))).toBeNull();
    expect(getEtaFailureStatus(reference, statusToken)).toMatchObject({ reference });
  });

  test('a reference is never reused while a report with that reference is still held', async () => {
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    const first = reportEtaFailure(normalizeReport(REPORT));
    await first.outcome;
    const clash = Buffer.from(first.reference.slice(4), 'hex');
    randomBytes
      .mockImplementationOnce(() => clash)
      .mockImplementationOnce(() => clash)
      .mockImplementationOnce(() => Buffer.from('abcdef', 'hex'));
    const second = reportEtaFailure(normalizeReport(REPORT));
    await second.outcome;
    randomBytes.mockRestore();
    expect(second.reference).toBe('FLT-abcdef');
    expect(getEtaFailureStatus(first.reference, first.statusToken)).toMatchObject({ reference: first.reference });
    expect(getEtaFailureStatus(second.reference, second.statusToken)).toMatchObject({ reference: second.reference });
  });

  test('a report emits a Datadog metric and a Sentry event tagged with the on-call route', async () => {
    const { reference, outcome } = reportEtaFailure(normalizeReport(REPORT));
    await outcome;
    expect(incrementMetric).toHaveBeenCalledWith('fleet_live_share.eta_failure', expect.objectContaining({
      route: '/api/oncall/26a3d261/eta-failure', platform: 'ios',
    }));
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = Sentry.captureMessage.mock.calls[0];
    expect(message).toContain('fleet-mobile/ios');
    expect(context.tags).toMatchObject({ route: '/api/oncall/26a3d261/eta-failure', service: 'fleet-mobile' });
    expect(context.extra).toMatchObject({ reference, assetId: '224221' });
    expect(JSON.stringify(context)).not.toContain('presenter@example.com');
  });

  test('reportEtaFailure ignores anything but a normalized report', () => {
    expect(reportEtaFailure(null)).toBeNull();
    expect(reportEtaFailure(REPORT)).toBeNull();
  });

  test('POST acknowledges with 202 and a reference; GET exposes the outcome', async () => {
    const response = await request(server, 'POST', PATH, REPORT);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      received: true,
      service: 'fleet-mobile',
      sessionRequested: true,
    });
    const { reference, statusToken } = response.body;
    expect(reference).toMatch(/^FLT-[0-9a-f]{6}$/);
    expect(statusToken).toMatch(/^[0-9a-f]{32}$/);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect((await request(server, 'GET', `${PATH}/${reference}`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/${reference}?token=${'f'.repeat(32)}`)).status).toBe(404);

    const status = await request(server, 'GET', `${PATH}/${reference}?token=${statusToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ reference, alertPosted: true });
    expect(status.body).not.toHaveProperty('statusToken');

    const viaHeader = await request(server, 'GET', `${PATH}/${reference}`, undefined, { 'X-Status-Token': statusToken });
    expect(viaHeader.status).toBe(200);
  });

  test('POST rejects foreign sources and malformed facts', async () => {
    const foreign = await request(server, 'POST', PATH, { ...REPORT, source: 'comed-account/web' });
    expect(foreign.status).toBe(400);
    expect(postMessage).not.toHaveBeenCalled();

    const malformed = await request(server, 'POST', PATH, { ...REPORT, departure: 'soon' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.received).toBe(false);

    const healthy = await request(server, 'POST', PATH, { ...REPORT, arrival: '2026-09-15T00:30:00Z' });
    expect(healthy.status).toBe(400);
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('malformed POSTs do not consume the hourly trigger cap', async () => {
    for (let i = 0; i < 60; i += 1) {
      const bad = await request(server, 'POST', PATH, { ...REPORT, departure: 'soon' });
      expect(bad.status).toBe(400);
    }
    const good = await request(server, 'POST', PATH, REPORT);
    expect(good.status).toBe(202);
  });

  test('GET rejects unknown or malformed references', async () => {
    expect((await request(server, 'GET', `${PATH}/FLT-000000`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/..%2Fetc`)).status).toBe(404);
  });
});

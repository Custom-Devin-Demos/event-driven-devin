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

const express = require('express');
const http = require('http');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');

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

function request(server, method, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
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

  test('normalizeReport rejects reports without asset or parseable times', () => {
    expect(normalizeReport({ ...REPORT, assetId: 'A-1' })).toBeNull();
    expect(normalizeReport({ ...REPORT, departure: 'yesterday' })).toBeNull();
    expect(normalizeReport({ ...REPORT, arrival: undefined })).toBeNull();
  });

  test('a report posts one alert, creates one macOS session on ios-demos and links it in the thread', async () => {
    const { reference, outcome } = reportEtaFailure(REPORT);
    expect(reference).toMatch(/^FLT-[0-9a-f]{6}$/);

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
    expect(getEtaFailureStatus(reference)).toEqual({
      reference,
      service: 'fleet-mobile',
      alertPosted: true,
      sessionUrl: 'https://app.devin.ai/sessions/session-fleet',
      done: true,
    });
  });

  test('a failed Slack post still creates the session', async () => {
    postMessage.mockRejectedValueOnce(new Error('slack down'));
    const { reference, outcome } = reportEtaFailure(REPORT);
    await outcome;

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(getEtaFailureStatus(reference)).toMatchObject({ alertPosted: false, sessionUrl: expect.any(String) });
  });

  test('POST acknowledges with 202 and a reference; GET exposes the outcome', async () => {
    const response = await request(server, 'POST', PATH, REPORT);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      received: true,
      service: 'fleet-mobile',
      sessionRequested: true,
    });
    const { reference } = response.body;
    expect(reference).toMatch(/^FLT-[0-9a-f]{6}$/);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const status = await request(server, 'GET', `${PATH}/${reference}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ reference, alertPosted: true });
  });

  test('POST rejects foreign sources and malformed facts', async () => {
    const foreign = await request(server, 'POST', PATH, { ...REPORT, source: 'comed-account/web' });
    expect(foreign.status).toBe(400);
    expect(postMessage).not.toHaveBeenCalled();

    const malformed = await request(server, 'POST', PATH, { ...REPORT, departure: 'soon' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.received).toBe(false);
  });

  test('GET rejects unknown or malformed references', async () => {
    expect((await request(server, 'GET', `${PATH}/FLT-000000`)).status).toBe(404);
    expect((await request(server, 'GET', `${PATH}/..%2Fetc`)).status).toBe(404);
  });
});

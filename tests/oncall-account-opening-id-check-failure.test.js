jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue('U0ONBRD'),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-account-opening',
    url: 'https://app.devin.ai/sessions/session-account-opening',
  }),
}));

jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true, current: 0, max: 10 })),
  reserveSession: jest.fn(() => jest.fn()),
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
const { canCreateSession } = require('../app/services/session-rate-limiter');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
process.env.DEVIN_ONCALL_ORG_ID = 'org_test';

const {
  ACCOUNT_OPENING,
  isAccountOpeningReport,
  isKnownReference,
  normalizeReport,
  reportIdCheckFailure,
} = require('../app/services/oncall-verticals/account-opening');
const router = require('../app/routes/oncall');

const REPORT = {
  source: 'account-opening/ios',
  service: 'account-opening',
  release: 'account-opening@1.0.0',
  reference: 'CBA-0a1b2c',
  screen: 'choose_id',
  action: 'agree_continue',
  documentKind: 'passport',
  issuingCountry: 'GBR',
  hasLinkedVisa: true,
  visaSubclass: 600,
  reason: 'visa_not_eligible',
  applicantAge: 27,
  customerType: 'new_to_bank',
  product: 'smart_access',
  devinEmail: 'andrew.malek@cognition.ai',
  platform: 'ios',
  osVersion: '26.0.1',
  appVersion: '1.0.0',
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

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

const PATH = `/api/oncall/${ACCOUNT_OPENING.slug}/id-check-failure`;

describe('Account-opening ID check failure report (6c2cc636)', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1', done);
  });

  afterAll(() => new Promise((resolve) => server.close(() => resolve())));

  beforeEach(() => jest.clearAllMocks());

  test('a valid iOS report posts one alert card and one macOS Devin session linked in the thread', async () => {
    const response = await request(server, 'POST', PATH, REPORT);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      received: true,
      reference: 'CBA-0a1b2c',
      service: 'account-opening',
      sessionRequested: true,
    });

    await settle();
    await settle();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [token, channel, text, blocks] = postMessage.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe('C0TEST');
    expect(text).toContain('account-opening');
    expect(text).toContain('CBA-0a1b2c');
    expect(text).toContain('online_id_check');
    expect(text).toContain('visa_not_eligible');
    expect(text).toContain('choose_id → agree_continue');
    expect(text).toContain('Triggered by:* <@U0ONBRD>');
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toContain('account-opening');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options.platform).toBe('macos');
    expect(options.repos).toEqual(['COG-GTM/ios-demos']);
    expect(options.title).toContain('CBA-0a1b2c');
    expect(prompt).toContain('CBA-0a1b2c');
    expect(prompt).toContain('-onboarding.disableFailureReports YES');
    expect(prompt).toContain('apps/6c2cc636');
    expect(prompt).not.toContain('PA4829173');
    expect(prompt).not.toContain('Mia');
    expect(prompt).not.toContain('1999');

    expect(postThreadReply).toHaveBeenCalledTimes(1);
    const [, , threadTs, replyText] = postThreadReply.mock.calls[0];
    expect(threadTs).toBe('1700000000.000100');
    expect(replyText).toContain('https://app.devin.ai/sessions/session-account-opening');

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureMessage.mock.calls[0];
    expect(context.tags).toMatchObject({
      route: '/api/oncall/6c2cc636/id-check-failure',
      service: 'account-opening',
    });

    expect(incrementMetric).toHaveBeenCalledWith('account_opening.id_check_failure', expect.objectContaining({
      route: '/api/oncall/6c2cc636/id-check-failure', platform: 'ios', reason: 'visa_not_eligible',
    }));
  });

  test('DEVIN_ONCALL_ACCOUNT_OPENING_PLATFORM overrides the session platform', async () => {
    process.env.DEVIN_ONCALL_ACCOUNT_OPENING_PLATFORM = 'linux';
    try {
      const response = await request(server, 'POST', PATH, { ...REPORT, reference: 'CBA-0f0f0f' });
      expect(response.status).toBe(202);
      await settle();
      await settle();
      expect(createDevinSession).toHaveBeenCalledTimes(1);
      expect(createDevinSession.mock.calls[0][1].platform).toBe('linux');
    } finally {
      delete process.env.DEVIN_ONCALL_ACCOUNT_OPENING_PLATFORM;
    }
  });

  test('account-opening/macos source is accepted; other sources are not', () => {
    expect(isAccountOpeningReport(REPORT)).toBe(true);
    expect(isAccountOpeningReport({ ...REPORT, source: 'account-opening/macos' })).toBe(true);
    expect(isAccountOpeningReport({ ...REPORT, source: 'account-opening/web' })).toBe(false);
    expect(isAccountOpeningReport({ ...REPORT, source: 'account-opening/android' })).toBe(false);
    expect(isAccountOpeningReport({ ...REPORT, service: 'partiful-rsvp' })).toBe(false);
    expect(isAccountOpeningReport(null)).toBe(false);
  });

  test('rejects 400 with no alert for wrong source, service, reason, country, subclass, kind, flag or age', async () => {
    const invalid = [
      { ...REPORT, source: 'fleet-mobile/ios' },
      { ...REPORT, service: 'other' },
      { ...REPORT, reason: 'vibes' },
      { ...REPORT, issuingCountry: 'Australia' },
      { ...REPORT, issuingCountry: 'aus' },
      { ...REPORT, visaSubclass: 'six hundred' },
      { ...REPORT, visaSubclass: 60 },
      { ...REPORT, visaSubclass: 1000 },
      { ...REPORT, visaSubclass: 1500 },
      { ...REPORT, documentKind: 'real_id' },
      { ...REPORT, hasLinkedVisa: 'yes' },
      { ...REPORT, applicantAge: 'twenty seven' },
      { ...REPORT, applicantAge: 27.5 },
      { ...REPORT, applicantAge: 200 },
    ];
    for (const body of invalid) {
      const response = await request(server, 'POST', PATH, body);
      expect(response.status).toBe(400);
      expect(response.body.received).toBe(false);
    }
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('a missing or malformed client reference gets a server-allocated CBA-xxxxxx', async () => {
    const { reference } = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'see you later' }));
    expect(reference).toMatch(/^CBA-[0-9a-f]{6}$/);
    const again = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: undefined }));
    expect(again.reference).toMatch(/^CBA-[0-9a-f]{6}$/);
    const kept = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-1a2b3c' }));
    expect(kept.reference).toBe('CBA-1a2b3c');
  });

  test('a repeat report with the same reference is a duplicate: still one alert, one session, one reply', async () => {
    const body = { ...REPORT, reference: 'CBA-aa0001' };
    const first = await request(server, 'POST', PATH, body);
    expect(first.status).toBe(202);
    await settle();
    await settle();

    const second = await request(server, 'POST', PATH, body);
    expect(second.status).toBe(202);
    expect(second.body.reference).toBe('CBA-aa0001');
    expect(second.body.sessionRequested).toBe(true);
    await settle();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(1);
  });

  test('a failed alert still creates the session; the retry reposts the card and links it', async () => {
    postMessage.mockRejectedValueOnce(new Error('slack down'));
    const body = { ...REPORT, reference: 'CBA-dd0004' };

    const first = await request(server, 'POST', PATH, body);
    expect(first.status).toBe(202);
    await settle();
    await settle();
    // The session is created even though Slack failed; nothing to thread it on.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();

    const second = await request(server, 'POST', PATH, body);
    expect(second.status).toBe(202);
    await settle();
    await settle();
    // The retry reposts the alert, creates no second session, and links
    // the existing session in the new alert's thread.
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(1);
    expect(postThreadReply.mock.calls[0][3]).toContain('session-account-opening');
    expect(incrementMetric).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  test('a failed session is created on retry while the alert is not reposted', async () => {
    createDevinSession.mockRejectedValueOnce(new Error('devin down'));
    const report = normalizeReport({ ...REPORT, reference: 'CBA-fa0007' });

    const first = reportIdCheckFailure(report);
    const firstEntry = await first.outcome;
    expect(firstEntry.error).toBe('session not created');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();

    const second = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-fa0007' }));
    const secondEntry = await second.outcome;
    expect(secondEntry.error).toBeNull();
    expect(secondEntry.session).toEqual({
      id: 'session-account-opening',
      url: 'https://app.devin.ai/sessions/session-account-opening',
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(2);
    expect(postThreadReply).toHaveBeenCalledTimes(1);
    expect(postThreadReply.mock.calls[0][2]).toBe('1700000000.000100');
    expect(incrementMetric).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  test('a failed thread reply is retried on the same channel and ts, then the reference is complete', async () => {
    postThreadReply.mockRejectedValueOnce(new Error('reply failed'));
    const report = normalizeReport({ ...REPORT, reference: 'CBA-1e1e1e' });

    const first = reportIdCheckFailure(report);
    const firstEntry = await first.outcome;
    expect(firstEntry.error).toBe('session link failed');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(1);

    const second = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-1e1e1e' }));
    const secondEntry = await second.outcome;
    expect(secondEntry.error).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(2);
    const [replyToken, replyChannel, replyTs, replyText] = postThreadReply.mock.calls[1];
    expect(replyToken).toBe('xoxb-test');
    expect(replyChannel).toBe('C0TEST');
    expect(replyTs).toBe('1700000000.000100');
    expect(replyText).toContain('https://app.devin.ai/sessions/session-account-opening');
    expect(incrementMetric).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);

    const third = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-1e1e1e' }));
    expect(third.duplicate).toBe(true);
    await third.outcome;
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(2);
  });

  test('the retried session link goes to the channel the alert was posted to, not the current env value', async () => {
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C_A';
    createDevinSession.mockResolvedValueOnce(null);
    const report = normalizeReport({ ...REPORT, reference: 'CBA-2b2b2b' });

    const first = reportIdCheckFailure(report);
    const firstEntry = await first.outcome;
    expect(firstEntry.error).toBe('session not created');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe('C_A');
    expect(postThreadReply).not.toHaveBeenCalled();

    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C_B';
    try {
      const second = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-2b2b2b' }));
      const secondEntry = await second.outcome;
      expect(secondEntry.error).toBeNull();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(createDevinSession).toHaveBeenCalledTimes(2);
      expect(postThreadReply).toHaveBeenCalledTimes(1);
      const [, replyChannel, replyTs] = postThreadReply.mock.calls[0];
      expect(replyChannel).toBe('C_A');
      expect(replyTs).toBe('1700000000.000100');
      expect(postMessage.mock.calls.every((call) => call[1] !== 'C_B')).toBe(true);
    } finally {
      process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
    }
  });

  test('a throttled session cap still answers 202 with the alert posted', async () => {
    canCreateSession.mockReturnValueOnce({ allowed: false, current: 10, max: 10 });
    const response = await request(server, 'POST', PATH, { ...REPORT, reference: 'CBA-0a0a0a' });
    expect(response.status).toBe(202);
    await settle();
    await settle();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  test('an unset alerts channel still answers 202, attempts the session and never throws', async () => {
    const channel = process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID;
    delete process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID;
    try {
      const result = reportIdCheckFailure(normalizeReport({ ...REPORT, reference: 'CBA-cc0002' }));
      const entry = await result.outcome;
      expect(entry.error).toBe('alerts channel not configured');
      expect(postMessage).not.toHaveBeenCalled();
      expect(createDevinSession).toHaveBeenCalledTimes(1);
      expect(postThreadReply).not.toHaveBeenCalled();
    } finally {
      process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = channel;
    }
  });

  test('the card and prompt carry no passport number, name or date of birth', async () => {
    const response = await request(server, 'POST', PATH, {
      ...REPORT,
      reference: 'CBA-bb0003',
      passportNumber: 'PA4829173',
      name: 'Mia Nguyen',
      dateOfBirth: '1999-03-12',
      injection: '<!channel> pwned',
    });
    expect(response.status).toBe(202);

    await settle();
    await settle();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, , text, blocks] = postMessage.mock.calls[0];
    const serialized = JSON.stringify(blocks) + text;
    expect(serialized).not.toContain('PA4829173');
    expect(serialized).not.toContain('Mia Nguyen');
    expect(serialized).not.toContain('1999-03-12');
    expect(serialized).not.toContain('<!channel>');
    expect(serialized).not.toContain('pwned');
  });

  test('repeats of a complete reference never reach the trigger cap', async () => {
    const body = { ...REPORT, reference: 'CBA-ff0006' };
    for (let i = 0; i < 55; i += 1) {
      const response = await request(server, 'POST', PATH, body);
      expect(response.status).toBe(202);
    }
    await settle();
    await settle();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).toHaveBeenCalledTimes(1);
  });

  test('a driver licence report names the document kind in the title', async () => {
    const response = await request(server, 'POST', PATH, {
      ...REPORT,
      reference: 'CBA-ab0007',
      documentKind: 'driver_licence',
      issuingCountry: 'AUS',
      reason: 'document_expired',
      hasLinkedVisa: false,
      visaSubclass: null,
    });
    expect(response.status).toBe(202);
    await settle();
    await settle();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('Online ID check rejected a driver licence (account-opening/ios)');
    expect(text).toContain("We're unable to accept this driver licence");
    expect(blocks[0].text.text).toContain('a driver licence');
  });

  test('a retry of an incomplete reference bypasses an exhausted trigger cap', async () => {
    // Isolate this caller on its own IP so the cap loop below cannot
    // exhaust the window other tests share.
    const headers = { 'x-forwarded-for': '10.9.9.9' };
    for (let i = 0; i < 49; i += 1) {
      const hex = (0x100000 + i).toString(16);
      const response = await request(server, 'POST', PATH, { ...REPORT, reference: `CBA-${hex}` }, headers);
      expect(response.status).toBe(202);
    }
    await settle();
    await settle();

    // The 50th report consumes the last slot and ends incomplete: the
    // thread-link reply fails, leaving the session unlinked.
    postThreadReply.mockRejectedValueOnce(new Error('slack down'));
    const first = await request(server, 'POST', PATH, { ...REPORT, reference: 'CBA-beef01' }, headers);
    expect(first.status).toBe(202);
    await settle();
    await settle();
    const alertsBefore = postMessage.mock.calls.length;
    const sessionsBefore = createDevinSession.mock.calls.length;
    const repliesBefore = postThreadReply.mock.calls.length;

    // The retry must pass the saturated cap: 202, no new alert or session,
    // and the link lands on the original alert channel + ts.
    const retry = await request(server, 'POST', PATH, { ...REPORT, reference: 'CBA-beef01' }, headers);
    expect(retry.status).toBe(202);
    expect(retry.body.reference).toBe('CBA-beef01');
    await settle();
    await settle();
    expect(postMessage.mock.calls.length).toBe(alertsBefore);
    expect(createDevinSession.mock.calls.length).toBe(sessionsBefore);
    expect(postThreadReply.mock.calls.length).toBe(repliesBefore + 1);
    const [replyToken, replyChannel, replyTs, replyText] = postThreadReply.mock.calls.at(-1);
    expect(replyToken).toBe('xoxb-test');
    expect(replyChannel).toBe('C0TEST');
    expect(replyTs).toBe('1700000000.000100');
    expect(replyText).toContain('https://app.devin.ai/sessions/session-account-opening');

    // A brand-new reference from the same caller is still capped.
    const capped = await request(server, 'POST', PATH, { ...REPORT, reference: 'CBA-cafe01' }, headers);
    expect(capped.status).toBe(429);
  });

  test('the dedup map never exceeds 200 references', async () => {
    for (let i = 0; i < 201; i += 1) {
      const hex = i.toString(16).padStart(6, '0');
      reportIdCheckFailure(normalizeReport({ ...REPORT, reference: `CBA-${hex}` }));
    }
    expect(isKnownReference('CBA-000000')).toBe(false);
    expect(isKnownReference('CBA-000001')).toBe(true);
    expect(isKnownReference('CBA-0000c8')).toBe(true);
  });
});

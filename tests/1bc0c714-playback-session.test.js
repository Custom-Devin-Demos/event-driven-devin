/* global describe, expect, test, jest, afterEach, beforeEach, setImmediate */

jest.mock('../app/services/slack', () => ({
  postMessage: jest.fn(() => Promise.resolve('1792090000.000100')),
  postThreadReply: jest.fn(() => Promise.resolve()),
  lookupSlackUserByEmail: jest.fn(() => Promise.resolve('U0TRIGGER1')),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 's-1', url: 'https://app.devin.ai/sessions/s-1' })),
}));
jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(() => Promise.resolve({ id: 'dd-1', publicId: 7 })),
}));
jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true })),
  reserveSession: jest.fn(() => jest.fn()),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const slack = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { Sentry } = require('../app/telemetry/sentry');
const { startPlaybackSession, resolveTitle, raiseOncallAlert, CATALOG } = require('../app/services/verticals/1bc0c714');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'playback@disneyplus.example',
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID'];
const savedEnv = {};

beforeEach(() => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0BNWUGCWBS';
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  jest.clearAllMocks();
});

describe('Disney+ playback sessions', () => {
  test('defaults to the Chad Powers hero title', () => {
    expect(resolveTitle(undefined).id).toBe('chad-powers');
  });

  test.each(['marvel-zombies', 'toy-story-5', 'hocus-pocus', 'chilean-mine-rescue', 'college-gameday'])('starts %s without alerting', async (titleId) => {
    const result = await startPlaybackSession({ titleId, device: 'web', ...IDENTITY });

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^DSS-[0-9A-F]{8}$/);
    expect(result.stream.manifestUrl).toMatch(/^https:\/\/.+\.m3u8$/);
    await flush();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('rejects unknown titles with a 404', async () => {
    await expect(startPlaybackSession({ titleId: 'not-a-title' })).rejects.toMatchObject({ statusCode: 404, code: 'TITLE_NOT_FOUND' });
  });

  test('the default hero title fails, captures to Sentry and raises the On-Call alert', async () => {
    await expect(startPlaybackSession({ device: 'web', ...IDENTITY })).rejects.toThrow(TypeError);
    await flush();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).toHaveBeenCalledWith('xoxb-test', 'C0BNWUGCWBS', expect.any(String), expect.any(Array));
  });

  test('catalog ids are unique', () => {
    const ids = CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('tagless Sentry issue webhooks are treated as already alerted', () => {
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/1bc0c714.js — buildPlaybackManifest',
    })).toBe(true);
  });
});

describe('Disney+ On-Call alert', () => {
  const failure = () => ({
    error: new TypeError("Cannot read properties of undefined (reading 'manifestBaseUrl')"),
    title: resolveTitle('chad-powers'),
    device: { key: 'web' },
    requestId: 'DSS-0000ABCD',
    requester: IDENTITY,
  });

  test('posts a monitor card to #oncall-alerts naming Anhang as On-Call', async () => {
    const result = await raiseOncallAlert(failure());

    expect(result).toMatchObject({ ok: true, ts: '1792090000.000100', sessionUrl: 'https://app.devin.ai/sessions/s-1' });
    const [, channel, text, blocks] = slack.postMessage.mock.calls[0];
    expect(channel).toBe('C0BNWUGCWBS');
    expect(text).toContain('[Triggered] 5xx rate — POST /api/1bc0c714/playback-session');
    const body = JSON.stringify(blocks);
    expect(body).toContain('<@U0BCD812VA5>');
    expect(body).toContain('Triggered by');
    expect(body).toContain('View in Datadog');
    expect(body).toContain('manifestBaseUrl');
  });

  test('declares a SEV-2 Datadog incident', async () => {
    await raiseOncallAlert(failure());
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'SEV-2',
      service: 'customer-1bc0c714-playback',
      triggeredBy: IDENTITY.devinEmail,
    }));
  });

  test('opens the Devin session as the requester and links it in the thread', async () => {
    await raiseOncallAlert(failure());
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({ orgId: 'org_demo', userId: 'clerk-user_demo', repos: ['COG-GTM/event-driven-devin'] });
    expect(prompt).toContain('channel=C0BNWUGCWBS thread_ts=1792090000.000100');
    expect(prompt).toContain('<@U0BCD812VA5>');
    expect(slack.postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0BNWUGCWBS', '1792090000.000100', expect.stringContaining('s-1'), expect.any(Array));
  });

  test('skips everything when the alerts channel is not configured', async () => {
    delete process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID;
    const result = await raiseOncallAlert(failure());
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
});

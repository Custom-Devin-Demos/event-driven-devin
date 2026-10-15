/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startPlaybackSession, resolveTitle, CATALOG } = require('../app/services/verticals/1bc0c714');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'playback@disneyplus.example',
};

afterEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
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
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects unknown titles with a 404', async () => {
    await expect(startPlaybackSession({ titleId: 'not-a-title' })).rejects.toMatchObject({ statusCode: 404, code: 'TITLE_NOT_FOUND' });
  });

  test('the default hero title fails and alerts with the customer identity', async () => {
    await expect(startPlaybackSession({ device: 'web', ...IDENTITY })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '1bc0c714',
      slackMemberId: 'U0BCD812VA5',
      devinUserId: IDENTITY.devinUserId,
      devinOrgId: IDENTITY.devinOrgId,
      devinEmail: IDENTITY.devinEmail,
    }));
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

  test('alerts route to #oncall-alerts', () => {
    const { getCustomerConfig } = require('../config/customers');
    expect(getCustomerConfig('1bc0c714').slackChannelId).toBe('C0BNWUGCWBS');
  });
});

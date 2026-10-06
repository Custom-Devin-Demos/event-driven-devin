/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const playbackRoutes = require('../app/routes/verticals/f2f7c956');
const {
  startPlaybackSession,
  listLineup,
  resolveChannel,
  lookupAdPolicy,
  buildStitcherParams,
} = require('../app/services/verticals/f2f7c956');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'playback@pluto.example',
};

function postPlayback(body) {
  const app = express();
  app.use(express.json());
  app.use(playbackRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/f2f7c956/playback-session',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

afterEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Pluto TV playback sessions', () => {
  test('lists the lineup with Trending Now as the default channel', () => {
    const channels = listLineup();
    expect(channels[0]).toEqual(expect.objectContaining({ slug: 'pluto-tv-trending-now', category: 'editorial' }));
    expect(channels.length).toBeGreaterThan(5);
  });

  test.each(['web', 'ios', 'android', 'roku', 'firetv', 'samsung'])('starts a %s session on a non-editorial channel without alerting', async (device) => {
    const result = await startPlaybackSession({ channel: 'pluto-tv-action', device, ...IDENTITY });

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^PTV-[0-9A-F]{8}$/);
    expect(result.channel.slug).toBe('pluto-tv-action');
    expect(result.device.key).toBe(device);
    expect(result.stream.url).toMatch(/^https:\/\/stitcher\.pluto\.tv\//);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ channel: 'not-a-channel', device: 'web' }, 'CHANNEL_NOT_FOUND'],
    [{ channel: 'pluto-tv-action', device: 'vcr' }, 'DEVICE_NOT_SUPPORTED'],
  ])('rejects invalid request %# with a 400 and no alert', async (body, code) => {
    const { status, body: response } = await postPlayback(body);

    expect(status).toBe(400);
    expect(response.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Pluto TV Trending Now (Watch Now default)', () => {
  test('has no ad policy for its editorial category', () => {
    const channel = resolveChannel('pluto-tv-trending-now');
    expect(channel.category).toBe('editorial');
    expect(lookupAdPolicy(channel)).toBeUndefined();
    expect(() => buildStitcherParams(channel, undefined, { key: 'web' })).toThrow(TypeError);
  });

  test('raises a TypeError and forwards the hub identity to the alert flow', async () => {
    await expect(startPlaybackSession({ channel: 'pluto-tv-trending-now', device: 'web', ...IDENTITY }))
      .rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'f2f7c956',
      errorType: 'TypeError',
      culprit: expect.stringContaining('app/services/verticals/f2f7c956.js'),
      ...IDENTITY,
    }));
  });

  test('returns a 500 whose requestId matches the alerted PTV reference', async () => {
    const { status, body } = await postPlayback({ channel: 'pluto-tv-trending-now', device: 'web' });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.code).toBe('PLAYBACK_SESSION_FAILED');
    expect(body.requestId).toMatch(/^PTV-[0-9A-F]{8}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('is on the Sentry webhook instant path so tagless issue webhooks do not double-alert', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/f2f7c956.js — buildStitcherParams' })).toBe(true);
  });
});

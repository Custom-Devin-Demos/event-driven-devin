/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const launchRoutes = require('../app/routes/verticals/ceb3f931');
const {
  launchForm,
  resolveResponseMode,
  buildLaunchManifest,
  RESPONSE_MODES,
  OWNER,
  SERVICE,
  ROUTE,
} = require('../app/services/verticals/ceb3f931');

const IDENTITY = {
  devinUserId: OWNER.devinUserId,
  devinOrgId: OWNER.devinOrgId,
};

function postLaunch(body) {
  const app = express();
  app.use(express.json());
  app.use(launchRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: ROUTE,
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

describe('Open Government Products form launch', () => {
  test('builds a manifest for a registered response mode', () => {
    const manifest = buildLaunchManifest({ formId: 'abc123', title: 'Post-ICT Survey' }, RESPONSE_MODES.encrypt);
    expect(manifest.responseMode).toBe('encrypt');
    expect(manifest.encryption.secretKeyRequired).toBe(true);
    expect(manifest.retention.days).toBe(30);
    expect(manifest.fields).toHaveLength(5);
  });

  test('the landing page launch (default storage mode) succeeds without raising an alert', async () => {
    const response = await postLaunch({
      action: 'Start building your form now',
      formTitle: 'Build secure government forms in minutes.',
      ...IDENTITY,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.referenceNumber).toMatch(/^FRM-/);
    expect(response.body.manifest.responseMode).toBe('encrypt');
    expect(response.body.manifest.modeLabel).toBe('Storage mode');
    expect(response.body.manifest.encryption.secretKeyRequired).toBe(true);
    expect(response.body.manifest.encryption.secretKeyFingerprint).toMatch(/^[0-9A-F]{16}$/);
    expect(response.body.manifest.retention.days).toBe(30);
    expect(response.body.manifest.title).toBe('Build secure government forms in minutes.');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the route default response mode resolves to a registered profile', () => {
    expect(launchRoutes.DEFAULT_RESPONSE_MODE).toBe('storage');
    expect(resolveResponseMode(launchRoutes.DEFAULT_RESPONSE_MODE)).toBe(RESPONSE_MODES.encrypt);
  });

  test('response modes resolve case- and whitespace-insensitively', () => {
    expect(resolveResponseMode('  Storage ')).toBe(RESPONSE_MODES.encrypt);
    expect(resolveResponseMode('EMAIL')).toBe(RESPONSE_MODES.email);
    expect(resolveResponseMode('multirespondent')).toBe(RESPONSE_MODES.multirespondent);
  });

  test.each([undefined, null, '', 'bogus', 42, 'toString', '__proto__'])(
    'unknown response mode %p throws a coded error instead of a TypeError',
    (mode) => {
      let caught;
      try { resolveResponseMode(mode); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect(caught.code).toBe('UNKNOWN_RESPONSE_MODE');
    },
  );

  test('an unknown response mode fails with a coded error and raises exactly one alert', async () => {
    const response = await postLaunch({
      action: 'Start building your form now',
      formTitle: 'Build secure government forms in minutes.',
      responseMode: 'bogus',
      ...IDENTITY,
    });

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('UNKNOWN_RESPONSE_MODE');
    expect(response.body.error).toBe('Unknown response mode: bogus');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('ceb3f931');
    expect(alert.service).toBe(SERVICE);
    expect(alert.slackMemberId).toBe('U08S7AVJ478');
    expect(alert.devinUserId).toBe(OWNER.devinUserId);
    expect(alert.devinOrgId).toBe(OWNER.devinOrgId);
    expect(alert.errorType).toBe('Error');
  });

  test('client-supplied Devin IDs cannot override the pinned owner', async () => {
    const response = await postLaunch({
      action: 'Start building your form now',
      formTitle: 'Build secure government forms in minutes.',
      responseMode: 'bogus',
      devinUserId: 'clerk-user_attacker',
      devinOrgId: 'org-attacker',
    });

    expect(response.status).toBe(500);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.devinUserId).toBe(OWNER.devinUserId);
    expect(alert.devinOrgId).toBe(OWNER.devinOrgId);
  });

  test('every click launches successfully regardless of label', async () => {
    const labels = ['Log in', 'Help', 'Get started', 'Expand masthead to find out how to identify an official government website'];
    for (const action of labels) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postLaunch({ action, ...IDENTITY });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.manifest.responseMode).toBe('encrypt');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a registered response mode launches successfully', async () => {
    const result = await launchForm({ action: 'Get started', title: 'Health declaration', responseMode: 'encrypt', ...IDENTITY });
    expect(result.success).toBe(true);
    expect(result.manifest.modeLabel).toBe('Storage mode');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the Sentry capture carries the instant-path tag so the webhook skips it', async () => {
    await postLaunch({ action: 'Start building your form now', responseMode: 'bogus', ...IDENTITY });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags.alert_path).toBe('instant');

    const webhookTags = Object.entries(context.tags).map(([key, value]) => ({ key, value }));
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'buildLaunchManifest', tags: webhookTags })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'buildLaunchManifest', tags: [{ key: 'route', value: ROUTE }] })).toBe(false);
  });

  test('tagless issue webhooks for this vertical are matched on the culprit module path', () => {
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'app/services/verticals/ceb3f931.js in buildLaunchManifest', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: `POST ${ROUTE}`, tags: [] })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'app/services/verticals/other.js in build', tags: [] })).toBe(false);
  });
});

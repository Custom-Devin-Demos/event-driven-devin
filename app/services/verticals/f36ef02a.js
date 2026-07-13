const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Release catalog with per-platform distribution channels.
 */
const RELEASES = [
  {
    platform: 'ios',
    label: 'iOS',
    channels: { stable: 'https://apps.example.com/ios/stable', beta: 'https://apps.example.com/ios/beta' },
  },
  {
    platform: 'android',
    label: 'Android',
    channels: { stable: 'https://apps.example.com/android/stable', beta: 'https://apps.example.com/android/beta' },
  },
  {
    platform: 'web',
    label: 'Web',
    channels: { stable: 'https://apps.example.com/web/stable', beta: 'https://apps.example.com/web/stable' },
  },
];

/**
 * Build the release matrix consumed by the installer resolver.
 */
function buildReleaseMatrix() {
  return RELEASES.map((release) => ({
    platformId: release.platform,
    label: release.label,
    channels: release.channels,
  }));
}

/**
 * Index matrix entries by platform for constant-time installer lookups.
 */
function indexReleases(matrix) {
  const index = {};
  for (const entry of matrix) {
    index[entry.platform] = { label: entry.label, channels: entry.channels };
  }
  return index;
}

/**
 * Resolve the installer link for the requested platform and channel.
 */
function resolveInstaller(releaseIndex, platform, channel) {
  const entry = releaseIndex[platform];
  return {
    platform,
    label: entry.label,
    installerUrl: entry.channels[channel] || entry.channels.stable,
  };
}

/**
 * Processes an app download link request.
 */
async function processDownloadRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing app download request', {
    requestId,
    platform: data.platform,
    locale: data.locale,
    service: 'customer-f36ef02a-download',
    route: '/api/f36ef02a/download',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const matrix = buildReleaseMatrix();
    const releaseIndex = indexReleases(matrix);
    const installer = resolveInstaller(releaseIndex, data.platform, data.channel);

    const result = {
      requestId,
      platform: installer.platform,
      label: installer.label,
      installerUrl: installer.installerUrl,
      locale: data.locale,
      issuedAt: new Date().toISOString(),
      success: true,
    };

    const duration = Date.now() - startTime;

    incrementMetric('app_download.success', {
      route: '/api/f36ef02a/download',
      platform: data.platform,
    });
    recordTiming('app_download.latency', duration, {
      route: '/api/f36ef02a/download',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('app_download.failure', {
      route: '/api/f36ef02a/download',
      errorClass: error.name,
    });
    recordTiming('app_download.latency', duration, {
      route: '/api/f36ef02a/download',
      error: 'true',
    });

    logger.error('App download request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      platform: data.platform,
      locale: data.locale,
      service: 'customer-f36ef02a-download',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f36ef02a/download',
        service: 'customer-f36ef02a-download',
        platform: data.platform,
      },
      extra: { requestId, platform: data.platform, locale: data.locale },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f36ef02a.js \u2014 resolveInstaller',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-f36ef02a-download',
      verticalLabel: 'App Download Link',
      customer: 'f36ef02a',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/f36ef02a/download' },
        { key: 'service', value: 'customer-f36ef02a-download' },
        { key: 'platform', value: data.platform },
      ],
      extra: { requestId, platform: data.platform, locale: data.locale },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-f36ef02a-download@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for download error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processDownloadRequest, RELEASES };

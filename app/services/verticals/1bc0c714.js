const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/1bc0c714/playback-session';
const SERVICE = 'customer-1bc0c714-playback';
const SLACK_MEMBER_ID = process.env.DISNEYPLUS_SLACK_MEMBER_ID || 'U0BCD812VA5';
const DEFAULT_TITLE = 'chad-powers';
const DEFAULT_DEVICE = 'web';

const CATALOG = [
  { id: 'chad-powers', title: 'Chad Powers', brand: 'hulu', type: 'series', season: 1, episode: 1, contentId: '323f7c16-2cd3-4c25-a1d8' },
  { id: 'secret-lives-of-mormon-wives', title: 'The Secret Lives of Mormon Wives', brand: 'hulu', type: 'series', season: 5, episode: 1, contentId: '36654fc5-c076-4aac-8d02' },
  { id: 'ahs-13', title: 'American Horror Story', brand: 'hulu', type: 'series', season: 13, episode: 1, contentId: '42dce787-f9de-405e-b211' },
  { id: 'the-drop', title: 'The Drop', brand: 'hulu', type: 'series', season: 1, episode: 4, contentId: 'cc2b4872-5a70-4c1e-a2bf' },
  { id: 'together', title: 'Together', brand: 'hulu', type: 'movie', contentId: '18f73b5b-fdd4-4977-8c82' },
  { id: 'the-substance', title: 'The Substance', brand: 'hulu', type: 'movie', contentId: 'd3dfb003-7f2b-4387-b3c7' },
  { id: 'heretic', title: 'Heretic', brand: 'hulu', type: 'movie', contentId: '2f841f3a-afde-4f3a-9b1f' },
  { id: 'hereditary', title: 'Hereditary', brand: 'hulu', type: 'movie', contentId: '9fa865c9-259d-4676-8a61' },
  { id: 'ready-or-not-2', title: 'Ready or Not 2: Here I Come', brand: 'hulu', type: 'movie', contentId: 'ecccf80f-41a5-4a9b-a2e3' },
  { id: 'greys-anatomy', title: "Grey's Anatomy", brand: 'hulu', type: 'series', season: 23, episode: 1, contentId: '8271ea55-28a2-4c69-9411' },
  { id: 'scrubs', title: 'Scrubs', brand: 'hulu', type: 'series', season: 2, episode: 1, contentId: '812cdf06-059d-4f84-a1d8' },
  { id: 'marvel-zombies', title: 'Marvel Zombies', brand: 'marvel', type: 'series', season: 1, episode: 1, contentId: 'af8f1dbe-5f40-4d0c-9d10' },
  { id: 'agatha-all-along', title: 'Agatha All Along', brand: 'marvel', type: 'series', season: 1, episode: 6, contentId: '147cf5d4-d156-4dd4-a6e7' },
  { id: 'toy-story-5', title: 'Toy Story 5', brand: 'pixar', type: 'movie', contentId: '394d3b50-0d4d-457e-b4c1' },
  { id: 'hocus-pocus', title: 'Hocus Pocus', brand: 'disney', type: 'movie', contentId: '170bdcdb-e5b2-4147-9af8' },
  { id: 'nightmare-before-christmas', title: "Tim Burton's The Nightmare Before Christmas", brand: 'disney', type: 'movie', contentId: '30f25af7-357f-42da-8de0' },
  { id: 'coven-academy', title: 'Coven Academy', brand: 'disney', type: 'series', season: 1, episode: 1, contentId: 'e2434900-f725-443c-a515' },
  { id: 'dancing-with-the-stars', title: 'Dancing with the Stars', brand: 'disney', type: 'series', season: 35, episode: 4, contentId: '1a51c09e-6cd2-4c2b-8379' },
  { id: 'chilean-mine-rescue', title: 'Chilean Mine Rescue: Race Against Time', brand: 'natgeo', type: 'series', season: 1, episode: 1, contentId: '229bd52a-380b-420f-8ac0' },
  { id: 'college-gameday', title: 'College GameDay', brand: 'espn', type: 'live', contentId: '2288b0fa-1e6a-4b12-a8b8' },
  { id: 'sportscenter', title: 'SportsCenter', brand: 'espn', type: 'live', contentId: '16e98262-dced-48ff-a61b' },
];

// Brand → packaging origin. Each brand gets a row when its library is
// re-packaged onto the unified Disney+ origin. Hulu titles joined the
// Disney+ catalog with the Hulu-on-Disney+ tile launch (catalog-sync
// v2026.10), ahead of the origin cut-over.
const CONTENT_ORIGINS = {
  disney: { manifestBaseUrl: 'https://vod-l3c-na-east-1.media.dssott.com/dpp/disney', packager: 'bamtech-cmaf', cdn: 'l3c' },
  pixar: { manifestBaseUrl: 'https://vod-l3c-na-east-1.media.dssott.com/dpp/pixar', packager: 'bamtech-cmaf', cdn: 'l3c' },
  marvel: { manifestBaseUrl: 'https://vod-akc-na-east-1.media.dssott.com/dpp/marvel', packager: 'bamtech-cmaf', cdn: 'akc' },
  starwars: { manifestBaseUrl: 'https://vod-akc-na-east-1.media.dssott.com/dpp/starwars', packager: 'bamtech-cmaf', cdn: 'akc' },
  natgeo: { manifestBaseUrl: 'https://vod-ftc-na-west-1.media.dssott.com/dpp/natgeo', packager: 'bamtech-cmaf', cdn: 'ftc' },
  espn: { manifestBaseUrl: 'https://live-akc-na-east-1.media.dssott.com/dpp/espn', packager: 'bamtech-ll-hls', cdn: 'akc' },
};

const DEVICE_PROFILES = {
  web: { label: 'Web (Chrome)', drm: 'widevine', securityLevel: 'L3', maxResolution: '1080p', codecs: ['avc1', 'hvc1'] },
  ios: { label: 'iOS', drm: 'fairplay', securityLevel: 'hardware', maxResolution: '4k', codecs: ['hvc1', 'dvh1'] },
  tvos: { label: 'Apple TV', drm: 'fairplay', securityLevel: 'hardware', maxResolution: '4k', codecs: ['hvc1', 'dvh1'] },
  android: { label: 'Android', drm: 'widevine', securityLevel: 'L1', maxResolution: '1080p', codecs: ['avc1', 'hvc1'] },
  roku: { label: 'Roku', drm: 'playready', securityLevel: 'SL3000', maxResolution: '4k', codecs: ['hvc1'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Disney+ "Play" playback-session start:',
  '- Service: `app/services/verticals/1bc0c714.js`',
  '- Route: `app/routes/verticals/1bc0c714.js`',
  '- Page: `app/public/verticals/1bc0c714.html` (served at `/1bc0c714`)',
  '',
  'Preserve the existing behavior for every brand in the catalog and every device profile.',
  'Run `npm run lint` and `npx jest tests/1bc0c714-playback-session.test.js`, and verify that pressing Play on the hero title on `/1bc0c714` starts playback.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveTitle(titleId) {
  const id = String(titleId || DEFAULT_TITLE).toLowerCase();
  const title = CATALOG.find((entry) => entry.id === id);

  if (!title) {
    const error = new Error('That title is not available in your region.');
    error.name = 'ValidationError';
    error.code = 'TITLE_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  return title;
}

function resolveDevice(deviceKey) {
  const key = String(deviceKey || DEFAULT_DEVICE).toLowerCase();
  const profile = DEVICE_PROFILES[key];

  if (!profile) {
    const error = new Error('Playback is not supported on this device.');
    error.name = 'ValidationError';
    error.code = 'DEVICE_NOT_SUPPORTED';
    error.statusCode = 400;
    throw error;
  }

  return { key, ...profile };
}

function resolveOrigin(title) {
  return CONTENT_ORIGINS[title.brand];
}

function buildPlaybackManifest(title, origin, device) {
  const assetPath = title.type === 'series'
    ? `${title.contentId}/s${title.season}e${title.episode}`
    : title.contentId;
  return {
    manifestUrl: `${origin.manifestBaseUrl}/${assetPath}/ctr-all-${device.maxResolution}.m3u8`,
    packager: origin.packager,
    cdn: origin.cdn,
    drm: device.drm,
    securityLevel: device.securityLevel,
    maxResolution: device.maxResolution,
    codecs: device.codecs,
  };
}

function buildPlaybackSession(requestId, title, device, manifest) {
  return {
    success: true,
    requestId,
    playbackSessionId: `dss_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    title: {
      id: title.id,
      title: title.title,
      brand: title.brand,
      type: title.type,
      season: title.season,
      episode: title.episode,
    },
    device: { key: device.key, label: device.label },
    stream: manifest,
    startedAt: new Date().toISOString(),
  };
}

async function startPlaybackSession(data) {
  const startTime = Date.now();
  const requestId = `DSS-${uuidv4().slice(0, 8).toUpperCase()}`;
  const title = resolveTitle(data.titleId);
  const device = resolveDevice(data.device);

  logger.info('Starting Disney+ playback session', {
    requestId,
    titleId: title.id,
    brand: title.brand,
    device: device.key,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));

    const origin = resolveOrigin(title);
    const manifest = buildPlaybackManifest(title, origin, device);
    const result = buildPlaybackSession(requestId, title, device, manifest);
    const duration = Date.now() - startTime;

    incrementMetric('playback_session.start_success', {
      route: ROUTE,
      brand: title.brand,
      device: device.key,
    });
    recordTiming('playback_session.start_latency', duration, { route: ROUTE });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('playback_session.start_failure', {
      route: ROUTE,
      brand: title.brand,
      device: device.key,
      errorClass: error.name,
    });
    recordTiming('playback_session.start_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Disney+ playback session failed to start', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      titleId: title.id,
      brand: title.brand,
      device: device.key,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        brand: title.brand,
        device: device.key,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        titleId: title.id,
        contentType: title.type,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/1bc0c714.js — buildPlaybackManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Disney+ Play',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '1bc0c714',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'title', value: title.id },
        { key: 'brand', value: title.brand },
        { key: 'device', value: device.key },
      ],
      extra: {
        requestId,
        title: title.title,
        brand: title.brand,
        contentType: title.type,
        errorCode: '83',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'dss-playback-web@4.12.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Disney+ playback error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  startPlaybackSession,
  resolveTitle,
  resolveDevice,
  resolveOrigin,
  buildPlaybackManifest,
  CATALOG,
};

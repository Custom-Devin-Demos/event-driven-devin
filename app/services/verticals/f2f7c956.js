const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/f2f7c956/playback-session';
const SERVICE = 'customer-f2f7c956-playback';
const SLACK_MEMBER_ID_FALLBACK = process.env.PLUTO_SLACK_MEMBER_ID || '';
const DEFAULT_CHANNEL = 'pluto-tv-trending-now';
const DEFAULT_DEVICE = 'web';

const LINEUP = [
  { slug: 'pluto-tv-trending-now', number: 1, name: 'Pluto TV Trending Now', category: 'editorial', nowPlaying: 'Total Recall', stitcherId: '673247127d5da5000817b4d6' },
  { slug: 'pluto-tv-spotlight', number: 2, name: 'Pluto TV Spotlight', category: 'featured', nowPlaying: 'Pet Sematary', stitcherId: '5ba3fb9c4b078e0f37ad34e8' },
  { slug: 'pluto-tv-franchise-favorites', number: 3, name: 'Pluto TV Franchise Favorites', category: 'featured', nowPlaying: 'Friday the 13th', stitcherId: '68fbf8101d26140175db8b58' },
  { slug: 'pluto-tv-icons', number: 4, name: 'Pluto TV Icons', category: 'series', nowPlaying: 'Life After Beth', stitcherId: '64b585f84ea480000838e446' },
  { slug: 'pluto-tv-rocky-creed', number: 5, name: 'Pluto TV ROCKY + Creed', category: 'movies', nowPlaying: 'Creed III', stitcherId: '6785b98d688edb0008cb99be' },
  { slug: 'pluto-tv-action', number: 54, name: 'Pluto TV Action', category: 'movies', nowPlaying: 'Clear and Present Danger', stitcherId: '561d7d484dc7c8770484914a' },
  { slug: 'pluto-tv-reaction', number: 70, name: 'Pluto TV Reaction', category: 'series', nowPlaying: 'Crawl', stitcherId: '617b37b361e0fd0008cfd8c5' },
  { slug: 'pluto-tv-fantastic', number: 61, name: 'Pluto TV Fantastic', category: 'movies', nowPlaying: 'Cloverfield', stitcherId: '5b64a245a202b3337f09e51d' },
  { slug: 'pluto-tv-comedy', number: 72, name: 'Pluto TV Comedy', category: 'series', nowPlaying: 'Election', stitcherId: '5a4d3a00ad95e4718ae8d8db' },
  { slug: 'pluto-tv-drama', number: 80, name: 'Pluto TV Drama', category: 'series', nowPlaying: 'Catch Me If You Can', stitcherId: '5b4e92e4694c027be6ecece1' },
];

// Ad-stitching policies per lineup category. The "editorial" category was
// introduced with the Trending Now channel and never received a policy row.
const AD_POLICIES = {
  featured: { podDurationSeconds: [60, 90], breakIntervalSeconds: 480, preRoll: true },
  movies: { podDurationSeconds: [90, 120], breakIntervalSeconds: 600, preRoll: false },
  series: { podDurationSeconds: [60, 60, 90], breakIntervalSeconds: 420, preRoll: true },
  kids: { podDurationSeconds: [30], breakIntervalSeconds: 720, preRoll: false },
  news: { podDurationSeconds: [30, 60], breakIntervalSeconds: 300, preRoll: true },
};

const PLAYBACK_PROFILES = {
  web: { label: 'Web', container: 'hls', drm: 'none', maxBitrateKbps: 6000, renditions: ['1080p', '720p', '480p', '360p'] },
  ios: { label: 'iOS', container: 'hls', drm: 'fairplay', maxBitrateKbps: 8000, renditions: ['1080p', '720p', '480p'] },
  android: { label: 'Android', container: 'dash', drm: 'widevine', maxBitrateKbps: 8000, renditions: ['1080p', '720p', '480p'] },
  roku: { label: 'Roku', container: 'hls', drm: 'none', maxBitrateKbps: 10000, renditions: ['1080p', '720p'] },
  firetv: { label: 'Fire TV', container: 'dash', drm: 'widevine', maxBitrateKbps: 10000, renditions: ['1080p', '720p'] },
  samsung: { label: 'Samsung TV', container: 'dash', drm: 'playready', maxBitrateKbps: 12000, renditions: ['1080p', '720p'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Pluto TV "Watch Now" playback-session start:',
  '- Service: `app/services/verticals/f2f7c956.js`',
  '- Route: `app/routes/verticals/f2f7c956.js`',
  '- Page: `app/public/verticals/f2f7c956.html` (served at `/f2f7c956`, `/pluto`)',
  '',
  'Preserve the existing behavior for every channel in the lineup and every playback profile.',
  'Run `npm run lint` and verify the "Watch Now" action on `/f2f7c956` starts a session for the default channel.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function listLineup() {
  return LINEUP.map((channel) => ({
    slug: channel.slug,
    number: channel.number,
    name: channel.name,
    category: channel.category,
    nowPlaying: channel.nowPlaying,
  }));
}

function resolveChannel(channelSlug) {
  const slug = String(channelSlug || DEFAULT_CHANNEL).toLowerCase();
  const channel = LINEUP.find((entry) => entry.slug === slug);

  if (!channel) {
    const error = new Error('That channel is not in the current lineup.');
    error.name = 'ValidationError';
    error.code = 'CHANNEL_NOT_FOUND';
    error.statusCode = 400;
    throw error;
  }

  return channel;
}

function resolveDevice(deviceKey) {
  const key = String(deviceKey || DEFAULT_DEVICE).toLowerCase();
  const profile = PLAYBACK_PROFILES[key];

  if (!profile) {
    const error = new Error('Playback is not supported on that device.');
    error.name = 'ValidationError';
    error.code = 'DEVICE_NOT_SUPPORTED';
    error.statusCode = 400;
    throw error;
  }

  return { key, ...profile };
}

function lookupAdPolicy(channel) {
  return AD_POLICIES[channel.category];
}

function buildStitcherParams(channel, policy, device) {
  return {
    stitcherId: channel.stitcherId,
    podDurations: policy.podDurationSeconds.join(','),
    breakInterval: policy.breakIntervalSeconds,
    preRoll: policy.preRoll,
    container: device.container,
    drm: device.drm,
  };
}

function buildStreamManifest(channel, device, stitcher) {
  const path = device.container === 'dash' ? 'master.mpd' : 'master.m3u8';
  return {
    url: `https://stitcher.pluto.tv/v2/stitch/${stitcher.stitcherId}/${path}`,
    container: device.container,
    drm: device.drm,
    renditions: device.renditions,
    maxBitrateKbps: device.maxBitrateKbps,
    adBreaks: {
      podDurations: stitcher.podDurations,
      intervalSeconds: stitcher.breakInterval,
      preRoll: stitcher.preRoll,
    },
  };
}

function buildPlaybackSession(requestId, channel, device, manifest) {
  return {
    success: true,
    requestId,
    sessionId: `ptv_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    channel: {
      slug: channel.slug,
      number: channel.number,
      name: channel.name,
      category: channel.category,
      nowPlaying: channel.nowPlaying,
    },
    device: { key: device.key, label: device.label },
    stream: manifest,
    startedAt: new Date().toISOString(),
  };
}

async function startPlaybackSession(data) {
  const startTime = Date.now();
  const requestId = `PTV-${uuidv4().slice(0, 8).toUpperCase()}`;
  const channel = resolveChannel(data.channel);
  const device = resolveDevice(data.device);

  logger.info('Starting Pluto TV playback session', {
    requestId,
    channel: channel.slug,
    device: device.key,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const policy = lookupAdPolicy(channel);
    const stitcher = buildStitcherParams(channel, policy, device);
    const manifest = buildStreamManifest(channel, device, stitcher);
    const result = buildPlaybackSession(requestId, channel, device, manifest);
    const duration = Date.now() - startTime;

    incrementMetric('playback_session.start_success', {
      route: ROUTE,
      channel: channel.slug,
      device: device.key,
    });
    recordTiming('playback_session.start_latency', duration, { route: ROUTE });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('playback_session.start_failure', {
      route: ROUTE,
      channel: channel.slug,
      device: device.key,
      errorClass: error.name,
    });
    recordTiming('playback_session.start_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Pluto TV playback session failed to start', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      channel: channel.slug,
      device: device.key,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        channel: channel.slug,
        device: device.key,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        channelName: channel.name,
        category: channel.category,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f2f7c956.js — buildStitcherParams',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Pluto TV Watch Now',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'f2f7c956',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'channel', value: channel.slug },
        { key: 'device', value: device.key },
      ],
      extra: {
        requestId,
        channelName: channel.name,
        category: channel.category,
        nowPlaying: channel.nowPlaying,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for playback session error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  startPlaybackSession,
  listLineup,
  resolveChannel,
  resolveDevice,
  lookupAdPolicy,
  buildStitcherParams,
  buildStreamManifest,
};

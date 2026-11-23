/**
 * Customer 55553439 — Live TV playback start for the web player.
 *
 * A viewer opens Live TV, picks a channel tile and presses Watch Live. The
 * player asks this service to start a live session: resolve the channel from
 * the guide lineup, resolve its server-side ad insertion (SSAI) policy, build
 * the ad pod schedule for the first hour and hand back a session + stream URL.
 *
 * Failures are reported to this customer's own Sentry project (SENTRY_DSN_55553439)
 * tagged environment=roku-web-live-tv / platform=web so they never mix with the
 * tvOS playback API events in the same project.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '55553439';
const SENTRY_ENV_SUFFIX = '55553439';
const SERVICE = 'roku-web-live-tv';
const ROUTE = '/api/55553439/playback';
const RELEASE = 'roku-web-live@2026.11.3';
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT_55553439 || 'roku-web-live-tv';
const SENTRY_TAGS = Object.freeze({
  platform: 'web',
  surface: 'the-roku-channel-web',
  service: SERVICE,
  customer: CUSTOMER,
});

let customerSentryScope;
function getCustomerSentryScope() {
  if (customerSentryScope !== undefined) return customerSentryScope;
  const dsn = process.env[`SENTRY_DSN_${SENTRY_ENV_SUFFIX}`];
  if (!dsn || typeof Sentry.NodeClient !== 'function') {
    customerSentryScope = null;
    return customerSentryScope;
  }
  const client = new Sentry.NodeClient({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: RELEASE,
    transport: Sentry.makeNodeTransport,
    stackParser: Sentry.defaultStackParser,
    integrations: [],
  });
  client.init();
  customerSentryScope = new Sentry.Scope();
  customerSentryScope.setClient(client);
  customerSentryScope.setTags(SENTRY_TAGS);
  return customerSentryScope;
}

function capturePlaybackError(error, context) {
  const scope = getCustomerSentryScope();
  if (scope) {
    scope.captureException(error, { captureContext: context });
    return;
  }
  Sentry.captureException(error, { ...context, tags: { ...SENTRY_TAGS, ...context.tags } });
}

function flushCustomerSentry(timeoutMs = 2000) {
  const scope = getCustomerSentryScope();
  const client = scope && scope.getClient();
  return client ? client.flush(timeoutMs) : Promise.resolve(true);
}

function sentryIssueUrl() {
  const org = process.env[`SENTRY_ORG_SLUG_${SENTRY_ENV_SUFFIX}`] || process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env[`SENTRY_PROJECT_ID_${SENTRY_ENV_SUFFIX}`] || process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&environment=${SENTRY_ENVIRONMENT}&query=is%3Aunresolved`;
}

// Guide lineup as served by the guide feed (v3). adPolicy keys the SSAI
// policy registry below.
const CHANNELS = Object.freeze([
  { id: "tyler-perry-drama", name: 'Tyler Perry Drama', onNow: "TV14 \u2022 2:52 am - 3:42 am THE VENDETTA \u2022 S3:E20", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/d1501ed3781f53bfb1143efc162c6aee/rokuFeed/assets/e21ee55644945642849aea1c4b072145.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "home-improvement", name: 'Home Improvement', onNow: "TVPG \u2022 2:54 am - 3:19 am HOME FOR THE HOLIDAYS \u2022 S", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/6d0103bde74463836393fd560eceb0d4/rokuFeed/assets/80f57bc9d2f85d508d92737e13d4cdbb.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "nbc-news-now", name: 'NBC News NOW', onNow: "TVPG \u2022 3:00 am - 3:30 am NBC NIGHTLY NEWS WITH TOM", adPolicy: 'fast-news-v3', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/b5fe4277ff365ccda0a7d43028d53d90/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2Fa8f905492d0b479fa2aab145074abd48%2Fposter%2F16_9%2FNone%2F1748972793983_NBC-News-NOW--Roku-key-art-tile.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "cbs-news-24-7", name: 'CBS News 24/7', onNow: "3:00 am - 3:30 am CBS WEEKEND NEWS", adPolicy: 'fast-news-v3', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/70881c73b6275623ace6c5c3603a339c/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2F31642de847ff428a9a2b47407c5553c9%2Fposter%2F16_9%2FNone%2F1737395893415_1737381613889_1730911310382_1730782842472_1727846814418_cbsn247_poster_art.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "game-show-central", name: 'Game Show Central', onNow: "TVPG \u2022 2:51 am - 3:17 am AMERICA SAYS \u2022 S3:E131", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/b89f979c548a5576a27bbe515c906814/rokuFeed/assets/b1aaf09e18155f5a88ee8ea9290dd085.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "universal-crime", name: 'Universal Crime', onNow: "TVPG \u2022 2:08 am - 3:30 am FADE IN TO MURDER \u2022 S6:E1", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/0322f5b9c0d954169122de194a8005ac/rokuFeed/assets/cb2ae374b80b5cbeaabaec68ca6beed5.png/magic/fit-in/440x480/filters:format(webp)" },
  { id: "the-first-48-beyond", name: 'The First 48 & Beyond', onNow: "TV14 \u2022 2:24 am - 3:15 am ESCAPE PLAN; PATH OF TERR", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/da9067306b4baa620da486ba6c9a3520/rokuFeed/assets/732769a2ca4a55d4965d824430d193aa.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "ion", name: 'ION', onNow: "TV14 \u2022 3:00 am - 4:00 am S.O.S. \u2022 S23:E16", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/7df7b616c8b2562191428c1eea9550bf/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2Ff9a0f901bc0e42939fce4abb537d12e1%2Fposter%2F16_9%2FNone%2F1764011326703_25_ION_LogoUpdateOTT_Roku.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "dateline-24-7", name: 'Dateline 24/7', onNow: "TV14 \u2022 2:31 am - 4:07 am WINDOW OF OPPORTUNITY \u2022 S", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/18c5f5feae8855baba4d1ccfd75be3db/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2F2787f8ef95db4c568fd6c3475ac2301a%2Fposter%2F16_9%2FNone%2F1754423607982_743a31cb75525395b88c5d36e39fe146.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "little-house-on-the-prairie", name: 'Little House on the Prairie', onNow: "TVPG \u2022 2:53 am - 3:48 am THE ANGRY HEART \u2022 S6:E13", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/54478298594f574c88887ed70a086267/rokuFeed/assets/6f9a60d880e6526fb6f0ba084e2923af.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "murder-she-wrote", name: 'Murder, She Wrote', onNow: "TVPG \u2022 3:02 am - 3:54 am MURDER IN TEMPO \u2022 S12:E14", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/56b8909fc7e75f2fabd2abc22a256020/rokuFeed/assets/18594c7b555f50a88557a37e338f8eae.png/magic/fit-in/440x480/filters:format(webp)" },
  { id: "in-the-heat-of-the-night", name: 'In the Heat of the Night', onNow: "TVPG \u2022 2:33 am - 3:30 am INTRUDERS \u2022 S2:E214", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/108bd1c824eaca47592ec02c00f0a18a/rokuFeed/assets/0ad1ee5c3c6e5dd7afd6e5f30a645a0b.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "leave-it-to-beaver", name: 'Leave It to Beaver', onNow: "NR \u2022 2:57 am - 3:24 am LARRY'S CLUB \u2022 S3:E22", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/227141061ce994a5401122a76c090f34/rokuFeed/assets/52823984a9b1506fa9c9163923dba5b6.png/magic/fit-in/440x480/filters:format(webp)" },
  { id: "the-virginian", name: 'The Virginian', onNow: "TVPG \u2022 2:19 am - 3:43 am MORGAN STARR \u2022 S4:E21", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/beba92338d91d6675ed207e15601875a/rokuFeed/assets/65f88d7c6365508faa6e79a5e51cdf6d.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "livenow-from-fox", name: 'LiveNOW from FOX', onNow: "2:00 am - 6:00 am LIVENOW FROM FOX", adPolicy: 'fast-news-v3', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/f9c0d48b540a55dcb98b04d2cc8abf25/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2F7b5c654c59554f36b20b4c9995ce65a3%2Fposter%2F16_9%2FNone%2F1737395854955_1725990461784_8a9a5856a3ac53049eddbb0b5646ef71.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "abc-news-20-20", name: 'ABC News 20/20', onNow: "1:43 am - 3:26 am NOTORIOUS: GHISLAINE MAXWELL \u2022 S", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/ce5378542a9fad88bfba4a5ff6269fcf/rokuFeed/assets/be3c2ff7d8555059980d63a5caa444c9.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "universal-westerns", name: 'Universal Westerns', onNow: "TVPG \u2022 2:42 am - 4:08 am THE SANTIAGO QUESADA STOR", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/8346cc0f3d415e39875fca80b67fd951/rokuFeed/assets/657dbc1089695caf9741efe6168c9381.png/magic/fit-in/440x480/filters:format(webp)" },
  { id: "cops-on-pluto", name: 'COPS on pluto', onNow: "TVPG \u2022 3:00 am - 3:30 am BOAT GUY \u2022 S16:E7", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/1a50b7ba48389669b3e0bc6750fe6b31/rokuFeed/assets/3a671097ccd65a09a27ac5c1b9f9df7a.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "like-nastya", name: 'Like Nastya', onNow: "TVY7 \u2022 2:38 am - 3:27 am NASTYA AND EVELYN - A STO", adPolicy: 'fast-kids-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/c0de867f29485305b9197b14cd08240f/rokuFeed/assets/13f9b0139a01528c81b58f3dd0949e6c.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "universal-monsters", name: 'Universal Monsters', onNow: "2:28 am - 4:21 am TREMORS II: AFTERSHOCKS", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/714890342efe5cd6b236e85415b661ca/rokuFeed/assets/28260f3a44c65c18b86ac068cfcffc85.png/magic/fit-in/440x480/filters:format(webp)" },
  { id: "love-hip-hop", name: 'Love & Hip Hop', onNow: "TV14 \u2022 3:00 am - 4:00 am OVER AND OUT \u2022 S3:E17", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/b8671587aa35a03aaab52b1891f15a87/rokuFeed/assets/cc001af3c05450279e3aad95dd6ffb68.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "abc13-houston", name: 'ABC13 Houston', onNow: "3:00 am - 3:30 am ABC13 EYEWITNESS NEWS AT 9PM", adPolicy: 'fast-news-v3', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/a29b3851293f5dab92a694af758f3822/rokuFeed/assets/21dab7461d50568ebecdfab68aa049c2.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "yo-gabba-gabba", name: 'Yo Gabba Gabba!', onNow: "TVY \u2022 3:06 am - 3:31 am GREEN \u2022 S2:E11", adPolicy: 'fast-kids-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/99a7477e0d38503d9b5456f07c1cf520/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2Fassets%2Fposter%2F16_9%2FNone%2F1674685413519_gabba.jpg/magic/fit-in/440x480/filters:format(webp)" },
  { id: "all-out-alaska", name: 'All-Out Alaska', onNow: "TV14 \u2022 2:24 am - 3:12 am HOMESTEAD FOR THE HOLIDAY", adPolicy: 'fast-entertainment-v2', image: "https://images.sr.roku.com/idType/roku-trc/context/trc/id/4fa77475640f5ab63700634c235d89a5/rokuFeed/assets/73d5a903a3fe53aaa419c971735c5d04.jpg/magic/fit-in/440x480/filters:format(webp)" },
]);

const CHANNELS_BY_ID = new Map(CHANNELS.map((c) => [c.id, c]));

// SSAI ad policy registry, keyed by the guide feed's adPolicy value.
//
// GUIDE-3184 (Nov 2026) moved the FAST news channels to guide feed v3, which
// re-keys their adPolicy from 'fast-news-v2' to 'fast-news-v3' so the player
// can honour the broadcaster's SCTE-35 break markers. The registry entry was
// scheduled to ship with the ad-decisioning release that follows the feed
// cut-over.
const AD_POLICIES = Object.freeze({
  'fast-entertainment-v2': {
    preroll: { maxSec: 30 },
    midroll: { cadenceSec: 900, podMaxSec: 120, source: 'interval' },
  },
  'fast-kids-v2': {
    preroll: { maxSec: 15 },
    midroll: { cadenceSec: 1200, podMaxSec: 60, source: 'interval' },
  },
  'fast-news-v2': {
    preroll: { maxSec: 15 },
    midroll: { cadenceSec: 720, podMaxSec: 90, source: 'interval' },
  },
});

const SCHEDULE_WINDOW_SEC = 3600;

function resolveAdPolicy(channel) {
  return AD_POLICIES[channel.adPolicy];
}

function buildAdPodSchedule(policy, windowSec = SCHEDULE_WINDOW_SEC) {
  const pods = [{ type: 'preroll', offsetSec: 0, maxSec: policy.preroll.maxSec }];
  for (let offset = policy.midroll.cadenceSec; offset < windowSec; offset += policy.midroll.cadenceSec) {
    pods.push({ type: 'midroll', offsetSec: offset, maxSec: policy.midroll.podMaxSec });
  }
  return pods;
}

function playbackError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function listLineup() {
  return CHANNELS.map(({ id, name, onNow, image }) => ({ id, name, onNow, image }));
}

async function startLivePlayback(data) {
  const requestId = `RKW-${uuidv4().slice(0, 8).toUpperCase()}`;
  const start = Date.now();
  const channelId = data.channelId;
  const channel = CHANNELS_BY_ID.get(channelId);
  if (!channel) {
    throw playbackError(`Unknown channel: ${String(channelId).slice(0, 64)}`, 'CHANNEL_NOT_FOUND', 404);
  }

  try {
    const policy = resolveAdPolicy(channel);
    const adPods = buildAdPodSchedule(policy);
    const sessionId = `RLS-${uuidv4().slice(0, 8).toUpperCase()}`;
    recordTiming('roku_web_live.playback_start.duration', Date.now() - start, [`channel:${channel.id}`]);
    incrementMetric('roku_web_live.playback_start.success', [`channel:${channel.id}`]);
    logger.info('Live playback session started', { requestId, customer: CUSTOMER, service: SERVICE, channelId: channel.id, sessionId });
    return {
      success: true,
      requestId,
      sessionId,
      channel: { id: channel.id, name: channel.name },
      streamUrl: `https://live.demo.invalid/${channel.id}/master.m3u8?session=${sessionId}`,
      adPods: adPods.length,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    incrementMetric('roku_web_live.playback_start.failure', [`channel:${channel.id}`, `ad_policy:${channel.adPolicy}`]);
    logger.error('Live playback start failed', {
      requestId,
      customer: CUSTOMER,
      service: SERVICE,
      error: error.message,
      errorClass: error.name,
      durationMs,
      channelId: channel.id,
      adPolicy: channel.adPolicy,
    });

    capturePlaybackError(error, {
      tags: {
        route: ROUTE,
        channel_id: channel.id,
        ad_policy: channel.adPolicy,
        error_code: 'PLAYBACK_START_FAILED',
        request_id: requestId,
      },
      fingerprint: ['roku-web-live-playback-start', error.name, channel.adPolicy],
      extra: { requestId, channelId: channel.id, adPolicy: channel.adPolicy, release: RELEASE },
    });
    await flushCustomerSentry();

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: sentryIssueUrl(),
      culprit: 'app/services/verticals/55553439.js \u2014 buildAdPodSchedule',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.viewerUserId,
      devinOrgId: data.viewerOrgId,
      devinEmail: data.viewerEmail,
      service: SERVICE,
      verticalLabel: 'Live TV Playback Start',
      customer: CUSTOMER,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'environment', value: SENTRY_ENVIRONMENT },
        { key: 'platform', value: 'web' },
        { key: 'channel_id', value: channel.id },
        { key: 'ad_policy', value: channel.adPolicy },
      ],
      extra: { requestId, ticketPrefix: 'RKW', channelId: channel.id },
    }).catch((alertError) => {
      logger.warn('Alert pipeline failed', { requestId, error: alertError.message });
    });

    const wrapped = playbackError(error.message, 'PLAYBACK_START_FAILED', 500);
    wrapped.name = error.name;
    wrapped.requestId = requestId;
    throw wrapped;
  }
}

module.exports = {
  CHANNELS,
  AD_POLICIES,
  listLineup,
  resolveAdPolicy,
  buildAdPodSchedule,
  startLivePlayback,
};

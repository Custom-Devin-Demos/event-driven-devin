/**
 * Client for the watch-progress service that backs StreamTV resume points.
 *
 * The real service is a separate deployment; here it is simulated in-process
 * with the latency profile measured against it in prod. Every call is logged
 * and timed so the home API's upstream fan-out is visible in Datadog.
 *
 * STREAMTV_UPSTREAM_LATENCY_SCALE (default 1) scales the simulated latency —
 * set it to 0 in unit tests.
 */

const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { WATCH_HISTORY, TITLE_BY_ID } = require('./streamtv-catalog');

const SERVICE = 'streamtv-home-api';
const UPSTREAM = 'watch-progress-service';

// Measured p50 latencies of the upstream endpoints (ms).
const LATENCY = {
  recent: [120, 160],
  progress: [190, 230],
  progressBatch: [110, 140],
};

// Roughly one in 300 single-key reads lands on a cold shard and stalls.
const COLD_SHARD_PROBABILITY = 0.003;
const COLD_SHARD_STALL_MS = 2400;

function latencyScale() {
  const raw = process.env.STREAMTV_UPSTREAM_LATENCY_SCALE;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function jitter([min, max]) {
  return Math.round((min + Math.random() * (max - min)) * latencyScale());
}

function progressRecord(profileId, titleId) {
  const entry = (WATCH_HISTORY[profileId] || []).find((e) => e.titleId === titleId);
  const title = TITLE_BY_ID.get(titleId);
  if (!entry || !title) return null;
  const positionSec = Math.round(title.durationSec * entry.fraction);
  return {
    profileId,
    titleId,
    season: entry.season,
    episode: entry.episode,
    positionSec,
    durationSec: title.durationSec,
    completed: entry.fraction >= 0.95,
    updatedAt: entry.lastWatchedAt,
  };
}

async function timed(operation, meta, work) {
  const started = Date.now();
  const result = await work();
  const durationMs = Date.now() - started;
  const tags = [`upstream:${UPSTREAM}`, `operation:${operation}`];
  recordTiming('streamtv.progress.upstream_call', durationMs, tags);
  incrementMetric('streamtv.progress.upstream_call.count', tags);
  logger.info('watch-progress lookup', { service: SERVICE, upstream: UPSTREAM, operation, durationMs, ...meta });
  return result;
}

/**
 * GET /v1/profiles/:profileId/recent — titles the profile opened recently,
 * most recent first. One call per profile.
 */
function listRecentlyWatched(profileId) {
  return timed('listRecentlyWatched', { profileId }, async () => {
    await sleep(jitter(LATENCY.recent));
    return (WATCH_HISTORY[profileId] || []).map((e) => ({
      titleId: e.titleId,
      season: e.season,
      episode: e.episode,
      lastWatchedAt: e.lastWatchedAt,
      completed: e.fraction >= 0.95,
    }));
  });
}

/**
 * GET /v1/profiles/:profileId/progress/:titleId — resume point for one title.
 */
function getProgress(profileId, titleId) {
  return timed('getProgress', { profileId, titleId }, async () => {
    let wait = jitter(LATENCY.progress);
    if (Math.random() < COLD_SHARD_PROBABILITY) wait += Math.round(COLD_SHARD_STALL_MS * latencyScale());
    await sleep(wait);
    return progressRecord(profileId, titleId);
  });
}

/**
 * POST /v1/profiles/:profileId/progress:batchGet — resume points for up to
 * 100 titles in one round trip.
 */
function getProgressBatch(profileId, titleIds) {
  return timed('getProgressBatch', { profileId, titleCount: titleIds.length }, async () => {
    await sleep(jitter(LATENCY.progressBatch));
    const out = {};
    for (const titleId of titleIds.slice(0, 100)) {
      const record = progressRecord(profileId, titleId);
      if (record) out[titleId] = record;
    }
    return out;
  });
}

module.exports = {
  listRecentlyWatched,
  getProgress,
  getProgressBatch,
  UPSTREAM,
};

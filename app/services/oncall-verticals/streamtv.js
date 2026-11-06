/**
 * streamtv-home-api — backend for the StreamTV 10-foot home screen.
 *
 *   GET  /api/home/rows                      → getHomeRows(profileId)
 *   GET  /api/home/continue-watching         → getContinueWatching(profileId)
 *   POST /api/playback/start                 → startPlayback(payload)
 *
 * Resume points come from the watch-progress service (see
 * ./streamtv-progress). Every request is timed and logged with a rolling
 * p95 for its route so the dashboards track the latency budget.
 */

const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const progress = require('./streamtv-progress');
const {
  PROFILES,
  PROFILE_BY_ID,
  TITLE_BY_ID,
  LIVE_CHANNELS,
  TRENDING_IDS,
  NEW_RELEASE_IDS,
  WATCH_HISTORY,
} = require('./streamtv-catalog');

const SERVICE = 'streamtv-home-api';
const RELEASE = 'streamtv-home-api@2026.11.3';

// Gateway deadline for home-screen requests; the TV client gives up at 10s.
const DEADLINE_MS = 8500;
const CONTINUE_WATCHING_LIMIT = 12;

const ROUTES = {
  rows: 'GET /api/home/rows',
  continueWatching: 'GET /api/home/continue-watching',
  playbackStart: 'POST /api/playback/start',
};

class HomeApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HomeApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Latency tracking (rolling window per route)
// ---------------------------------------------------------------------------

const LATENCY_WINDOW = 200;
const latencyWindows = new Map();

function recordLatency(route, durationMs) {
  const window = latencyWindows.get(route) || [];
  window.push(durationMs);
  if (window.length > LATENCY_WINDOW) window.shift();
  latencyWindows.set(route, window);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function getLatencyStats(route) {
  const window = latencyWindows.get(route) || [];
  return { route, samples: window.length, p50Ms: percentile(window, 50), p95Ms: percentile(window, 95) };
}

function withDeadline(work, route) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new HomeApiError(504, 'GATEWAY_TIMEOUT', `${route} exceeded the ${DEADLINE_MS}ms gateway deadline`)), DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function serve(route, meta, work) {
  const started = Date.now();
  let status = 200;
  try {
    return await withDeadline(work(), route);
  } catch (error) {
    status = error.status || 500;
    throw error;
  } finally {
    const durationMs = Date.now() - started;
    recordLatency(route, durationMs);
    const stats = getLatencyStats(route);
    const tags = [`service:${SERVICE}`, `route:${route}`, `status:${status}`];
    recordTiming('streamtv.home.request.duration', durationMs, tags);
    incrementMetric('streamtv.home.request.count', tags);
    if (status >= 500) incrementMetric('streamtv.home.request.errors', tags);
    logger[status >= 500 ? 'warn' : 'info']('home request served', {
      service: SERVICE,
      release: RELEASE,
      route,
      status,
      durationMs,
      p95Ms: stats.p95Ms,
      ...meta,
    });
  }
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

function requireProfile(profileId) {
  const profile = PROFILE_BY_ID.get(profileId);
  if (!profile) throw new HomeApiError(404, 'PROFILE_NOT_FOUND', `Unknown profile ${profileId}`);
  return profile;
}

function formatDuration(sec) {
  const minutes = Math.max(1, Math.round(sec / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function tile(title, extra) {
  return {
    titleId: title.id,
    title: title.title,
    kind: title.kind,
    genre: title.genre,
    year: title.year,
    rating: title.rating,
    durationLabel: formatDuration(title.durationSec),
    art: title.art,
    ...extra,
  };
}

function episodeLabel(entry) {
  return entry.season ? `S${entry.season} E${entry.episode}` : null;
}

function liveTile(channel) {
  const elapsed = channel.startedMinAgo;
  return {
    titleId: channel.id,
    title: channel.program,
    kind: 'live',
    genre: 'live',
    channelNumber: channel.number,
    channelName: channel.name,
    art: ['#4A1030', '#C8355F'],
    progressPct: Math.min(99, Math.round((elapsed / channel.runtimeMin) * 100)),
    durationLabel: `${channel.runtimeMin - elapsed} min left`,
  };
}

// ---------------------------------------------------------------------------
// Continue Watching
// ---------------------------------------------------------------------------

function remainingLabel(record) {
  const remaining = Math.max(0, record.durationSec - record.positionSec);
  return `${formatDuration(remaining)} left`;
}

async function buildContinueWatching(profileId) {
  const recent = await progress.listRecentlyWatched(profileId);
  const items = [];
  for (const entry of recent) {
    const record = await progress.getProgress(profileId, entry.titleId);
    if (!record || record.completed) continue;
    items.push(tile(TITLE_BY_ID.get(entry.titleId), {
      episodeLabel: episodeLabel(entry),
      lastWatchedAt: entry.lastWatchedAt,
      progressPct: Math.round((record.positionSec / record.durationSec) * 100),
      remainingLabel: remainingLabel(record),
      resumeFromSec: record.positionSec,
    }));
  }
  items.splice(CONTINUE_WATCHING_LIMIT);
  return {
    profileId,
    row: { id: 'continue-watching', title: 'Continue Watching', items },
    generatedAt: new Date().toISOString(),
  };
}

function getContinueWatching(profileId) {
  requireProfile(profileId);
  return serve(ROUTES.continueWatching, { profileId }, () => buildContinueWatching(profileId));
}

// ---------------------------------------------------------------------------
// Home rows
// ---------------------------------------------------------------------------

function becauseYouWatched(profileId) {
  const recent = WATCH_HISTORY[profileId] || [];
  const seed = recent.map((e) => TITLE_BY_ID.get(e.titleId)).find((t) => t && t.kind === 'series') || TITLE_BY_ID.get('t001');
  const watched = new Set(recent.map((e) => e.titleId));
  const items = [...TITLE_BY_ID.values()]
    .filter((t) => t.genre === seed.genre && t.id !== seed.id && !watched.has(t.id))
    .concat([...TITLE_BY_ID.values()].filter((t) => t.genre !== seed.genre && t.genre !== 'kids' && !watched.has(t.id)))
    .slice(0, 10)
    .map((t) => tile(t));
  return { id: 'because-you-watched', title: `Because You Watched ${seed.title}`, items };
}

function getHomeRows(profileId) {
  const profile = requireProfile(profileId);
  return serve(ROUTES.rows, { profileId }, async () => ({
    profileId,
    profile: { id: profile.id, name: profile.name, avatar: profile.avatar, color: profile.color },
    profiles: PROFILES.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color })),
    rows: [
      { id: 'continue-watching', title: 'Continue Watching', deferred: true, href: `/api/home/continue-watching?profileId=${encodeURIComponent(profileId)}` },
      { id: 'trending', title: 'Trending', items: TRENDING_IDS.map((id) => tile(TITLE_BY_ID.get(id))) },
      { id: 'live-tv', title: 'Live TV', items: LIVE_CHANNELS.map(liveTile) },
      becauseYouWatched(profileId),
      { id: 'new-releases', title: 'New Releases', items: NEW_RELEASE_IDS.map((id) => tile(TITLE_BY_ID.get(id))) },
    ],
    generatedAt: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function formatClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function startPlayback(payload) {
  const profileId = String(payload.profileId || '');
  const titleId = String(payload.titleId || '');
  const row = String(payload.row || '');
  requireProfile(profileId);
  const title = TITLE_BY_ID.get(titleId);
  const channel = LIVE_CHANNELS.find((c) => c.id === titleId);
  if (!title && !channel) throw new HomeApiError(404, 'TITLE_NOT_FOUND', `Unknown title ${titleId}`);

  return serve(ROUTES.playbackStart, { profileId, titleId, row }, async () => {
    let resumeFromSec = 0;
    if (row === 'continue-watching' && title) {
      // Resume from the same point the tile shows.
      const { row: continueWatching } = await buildContinueWatching(profileId);
      const item = continueWatching.items.find((i) => i.titleId === titleId);
      if (item) resumeFromSec = item.resumeFromSec;
    }
    const playbackId = `pb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return {
      playbackId,
      profileId,
      titleId,
      title: title ? title.title : channel.program,
      kind: title ? title.kind : 'live',
      resumeFromSec,
      resumeLabel: resumeFromSec ? `Resuming at ${formatClock(resumeFromSec)}` : (channel ? 'Joining live' : 'Playing from the beginning'),
      streamUrl: `https://cdn.streamtv.example/manifests/${titleId}/master.m3u8`,
      drm: 'widevine-l1',
      startedAt: new Date().toISOString(),
    };
  });
}

function resetForTests() {
  latencyWindows.clear();
}

module.exports = {
  SERVICE,
  RELEASE,
  DEADLINE_MS,
  ROUTES,
  HomeApiError,
  getHomeRows,
  getContinueWatching,
  startPlayback,
  getLatencyStats,
  resetForTests,
};

const logger = require('../telemetry/logger');

/**
 * Global sliding-window rate limiter for Devin session creation.
 *
 * Tracks timestamps of all sessions created within a configurable window.
 * When the cap is reached, new session creation is blocked until older
 * entries age out of the window.
 *
 * Configuration (via env vars with sensible defaults):
 *   SESSION_CAP_GLOBAL_MAX      — max sessions in the window (default: 30)
 *   SESSION_CAP_WINDOW_MINUTES  — sliding window duration   (default: 10)
 */

const parsedMax = parseInt(process.env.SESSION_CAP_GLOBAL_MAX, 10);
const GLOBAL_MAX = Number.isNaN(parsedMax) ? 30 : parsedMax;
const parsedWindow = parseInt(process.env.SESSION_CAP_WINDOW_MINUTES, 10);
const WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;

// In-memory sliding window — array of timestamps (ms since epoch)
const sessionTimestamps = [];

/**
 * Prune timestamps older than the sliding window.
 */
function pruneWindow() {
  const cutoff = Date.now() - WINDOW_MS;
  while (sessionTimestamps.length > 0 && sessionTimestamps[0] < cutoff) {
    sessionTimestamps.shift();
  }
}

/**
 * Check whether a new session is allowed under the global cap.
 *
 * @returns {{ allowed: boolean, current: number, max: number, windowMinutes: number, retryAfterSeconds: number|null }}
 */
function canCreateSession() {
  pruneWindow();

  const current = sessionTimestamps.length;

  if (current >= GLOBAL_MAX) {
    // Calculate how long until the oldest entry expires
    const oldestTs = sessionTimestamps[0];
    const retryAfterSeconds = Math.ceil(((oldestTs + WINDOW_MS) - Date.now()) / 1000);

    logger.warn('Session creation throttled — global cap reached', {
      current,
      max: GLOBAL_MAX,
      windowMinutes: WINDOW_MS / 60000,
      retryAfterSeconds,
    });

    return {
      allowed: false,
      current,
      max: GLOBAL_MAX,
      windowMinutes: WINDOW_MS / 60000,
      retryAfterSeconds: Math.max(retryAfterSeconds, 1),
    };
  }

  return {
    allowed: true,
    current,
    max: GLOBAL_MAX,
    windowMinutes: WINDOW_MS / 60000,
    retryAfterSeconds: null,
  };
}

/**
 * Optimistically reserve a session slot BEFORE the async API call.
 * Returns a release function to call if the API call fails, so the
 * slot is freed and doesn't consume cap budget.
 *
 * This prevents a TOCTOU race where concurrent requests all pass
 * canCreateSession() during the async gap before recordSession().
 *
 * @returns {Function} release — call this if the session creation fails
 */
function reserveSession() {
  const ts = Date.now();
  sessionTimestamps.push(ts);
  return function release() {
    const idx = sessionTimestamps.indexOf(ts);
    if (idx !== -1) {
      sessionTimestamps.splice(idx, 1);
    }
  };
}

/**
 * Record that a session was successfully created.
 * Call this AFTER the Devin API call succeeds.
 * @deprecated Use reserveSession() instead for race-safe reservations.
 */
function recordSession() {
  pruneWindow();
  sessionTimestamps.push(Date.now());
}

/**
 * Get current session stats for the admin endpoint.
 *
 * @returns {{ current: number, max: number, windowMinutes: number, remaining: number, oldestSessionAge: number|null }}
 */
function getSessionStats() {
  pruneWindow();

  const current = sessionTimestamps.length;
  const oldestAge = current > 0
    ? Math.round((Date.now() - sessionTimestamps[0]) / 1000)
    : null;

  return {
    current,
    max: GLOBAL_MAX,
    windowMinutes: WINDOW_MS / 60000,
    remaining: Math.max(GLOBAL_MAX - current, 0),
    oldestSessionAgeSeconds: oldestAge,
  };
}

module.exports = {
  canCreateSession,
  reserveSession,
  recordSession,
  getSessionStats,
};

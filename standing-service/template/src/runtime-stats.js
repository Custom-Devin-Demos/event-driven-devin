'use strict';

// Shared in-process counters surfaced by the admin status endpoint.

const stats = {
  armedAt: null,
  errorsSinceArm: 0,
  lastHeartbeatAt: null,
};

function markArmed(at = new Date()) {
  stats.armedAt = at.toISOString();
  stats.errorsSinceArm = 0;
}

function markDisarmed() {
  stats.armedAt = null;
  stats.errorsSinceArm = 0;
}

function recordIngestFailure() {
  if (stats.armedAt) stats.errorsSinceArm += 1;
}

function recordHeartbeat() {
  stats.lastHeartbeatAt = Date.now();
}

function heartbeatAgeSeconds() {
  if (!stats.lastHeartbeatAt) return null;
  return Math.round((Date.now() - stats.lastHeartbeatAt) / 1000);
}

module.exports = {
  stats,
  markArmed,
  markDisarmed,
  recordIngestFailure,
  recordHeartbeat,
  heartbeatAgeSeconds,
};

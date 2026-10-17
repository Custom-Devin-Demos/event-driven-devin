'use strict';

// Slack profile photos for roster members, shown on cards, the App Home and
// `/fcto free`. Rendering is synchronous and reads this cache; `warm()` fills
// it via users.info (users:read scope) before a render, bounded by a short
// timeout so a slow Slack API never delays a card. The profile email is kept
// too (only returned with the users:read.email scope) for calendar invites.

const slack = require('./slack-client');
const logger = require('../../telemetry/logger');

const TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const WARM_TIMEOUT_MS = 1500;

const cache = new Map(); // slackId -> { url, email, at }
const inflight = new Map();

function fresh(entry, now) {
  return entry && now - entry.at < (entry.url || entry.email ? TTL_MS : MISS_TTL_MS);
}

function get(slackId) {
  const entry = slackId && cache.get(slackId);
  return entry && entry.url ? entry.url : null;
}

function getEmail(slackId) {
  const entry = slackId && cache.get(slackId);
  return entry && entry.email ? entry.email : null;
}

function fetchOne(slackId) {
  if (inflight.has(slackId)) return inflight.get(slackId);
  const run = (async () => {
    let url = null;
    let email = null;
    try {
      const res = await slack.userInfo(slackId);
      const profile = res && res.ok && res.user && res.user.profile;
      url = (profile && (profile.image_192 || profile.image_72 || profile.image_48)) || null;
      email = (profile && profile.email) || null;
    } catch (err) {
      logger.warn('fcto: users.info failed', { error: err.message });
    }
    cache.set(slackId, { url, email, at: Date.now() });
  })().finally(() => inflight.delete(slackId));
  inflight.set(slackId, run);
  return run;
}

async function warm(slackIds) {
  const now = Date.now();
  const todo = Array.from(new Set((slackIds || []).filter(Boolean))).filter((id) => !fresh(cache.get(id), now));
  if (!todo.length) return;
  let timer;
  await Promise.race([
    Promise.all(todo.map(fetchOne)),
    new Promise((resolve) => { timer = setTimeout(resolve, WARM_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
}

function clear() {
  cache.clear();
}

module.exports = { get, getEmail, warm, clear, _cache: cache };

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../telemetry/logger');
const { createDevinSession } = require('../services/devin-api');
const { canCreateSession, reserveSession } = require('../services/session-rate-limiter');

const router = express.Router();
const RUN_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PER_HOUR = 3;
const DEFAULT_ATTACH_WINDOW_MINUTES = 15;
const prompt = fs.readFileSync(
  path.join(__dirname, '../../prompts/automations-patrol-backtest.md'),
  'utf8',
);
const runMaxPerHour = environmentInteger('AUTOMATIONS_RUN_MAX_PER_HOUR', DEFAULT_MAX_PER_HOUR);
const attachWindowMinutes = environmentInteger(
  'AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES',
  DEFAULT_ATTACH_WINDOW_MINUTES,
);
const runTimestamps = [];
let lastPatrolSession;

function environmentInteger(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isNaN(value) ? fallback : value;
}

function pruneRunTimestamps(now) {
  const cutoff = now - RUN_WINDOW_MS;
  while (runTimestamps.length && runTimestamps[0] <= cutoff) {
    runTimestamps.shift();
  }
}

function tokenMatches(presentedToken, configuredToken) {
  if (typeof presentedToken !== 'string' || presentedToken.length !== configuredToken.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(presentedToken),
    Buffer.from(configuredToken),
  );
}

function reject(res, status, reason, extra = {}) {
  return res.status(status).json({ success: false, reason, ...extra });
}

function retryAfterSeconds(now) {
  return Math.max(Math.ceil((runTimestamps[0] + RUN_WINDOW_MS - now) / 1000), 1);
}

router.get('/automations', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/automations.html'));
});

router.post('/api/automations/run', async (req, res) => {
  const configuredToken = process.env.AUTOMATIONS_RUN_TOKEN;
  if (!configuredToken) {
    logger.warn('Automations run rejected', {
      event: 'automations.run.rejected',
      reason: 'not_configured',
    });
    return reject(res, 503, 'not_configured');
  }

  const presentedToken = req.query.token || req.headers['x-automations-token'];
  if (!tokenMatches(presentedToken, configuredToken)) {
    logger.warn('Automations run rejected', {
      event: 'automations.run.rejected',
      reason: 'forbidden',
    });
    return reject(res, 403, 'forbidden');
  }

  const now = Date.now();
  pruneRunTimestamps(now);
  if (
    lastPatrolSession
    && now - lastPatrolSession.timestamp < attachWindowMinutes * 60 * 1000
  ) {
    logger.info('Automations run attached to existing session', {
      event: 'automations.run.attached',
      sessionId: lastPatrolSession.sessionId,
    });
    return res.json({ success: true, ...lastPatrolSession, attached: true });
  }

  if (runMaxPerHour <= 0 || runTimestamps.length >= runMaxPerHour) {
    const retryAfter = runTimestamps.length ? retryAfterSeconds(now) : 3600;
    logger.warn('Automations run throttled', {
      event: 'automations.run.throttled',
      retryAfterSeconds: retryAfter,
    });
    res.set('Retry-After', String(retryAfter));
    return reject(res, 429, 'throttled', { retryAfterSeconds: retryAfter });
  }

  const globalCap = canCreateSession();
  if (!globalCap.allowed) {
    logger.warn('Automations run throttled by global session cap', {
      event: 'automations.run.throttled',
      retryAfterSeconds: globalCap.retryAfterSeconds,
    });
    res.set('Retry-After', String(globalCap.retryAfterSeconds));
    return reject(res, 429, 'throttled', {
      retryAfterSeconds: globalCap.retryAfterSeconds,
    });
  }

  const releaseSessionSlot = reserveSession();
  runTimestamps.push(now);

  try {
    const session = await createDevinSession(prompt, {
      title: 'Slow Query Patrol backtest',
    });
    if (!session) {
      releaseSessionSlot();
      runTimestamps.splice(runTimestamps.indexOf(now), 1);
      logger.error('Automations run rejected', {
        event: 'automations.run.rejected',
        reason: 'not_configured',
      });
      return reject(res, 500, 'not_configured');
    }

    lastPatrolSession = {
      sessionId: session.sessionId,
      url: session.url,
      timestamp: Date.now(),
    };
    logger.info('Automations patrol session spawned', {
      event: 'automations.run.spawned',
      sessionId: session.sessionId,
    });
    return res.json({ success: true, ...lastPatrolSession, attached: false });
  } catch (error) {
    releaseSessionSlot();
    runTimestamps.splice(runTimestamps.indexOf(now), 1);
    logger.error('Automations run failed', {
      event: 'automations.run.rejected',
      reason: 'error',
      error: error.message,
    });
    return reject(res, 500, 'error');
  }
});

module.exports = router;
module.exports.constants = {
  RUN_WINDOW_MS,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_ATTACH_WINDOW_MINUTES,
};

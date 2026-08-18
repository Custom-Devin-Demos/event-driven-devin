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
const DEFAULT_ATTACH_WINDOW_MINUTES = 45;
const FAILED_TOKEN_WINDOW_MS = 10 * 60 * 1000;
const FAILED_TOKEN_MAX = 10;
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
const failedTokenTimestamps = [];
let lastPatrolSession;
let inFlightSpawn;

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
  if (typeof presentedToken !== 'string') {
    return false;
  }
  const presentedDigest = crypto.createHash('sha256').update(presentedToken).digest();
  const configuredDigest = crypto.createHash('sha256').update(configuredToken).digest();
  return crypto.timingSafeEqual(
    presentedDigest,
    configuredDigest,
  );
}

function reject(res, status, reason, extra = {}) {
  if (res.headersSent || res.destroyed) {
    return undefined;
  }
  return res.status(status).json({ success: false, reason, ...extra });
}

function retryAfterSeconds(timestamps, windowMs, now) {
  return Math.max(Math.ceil((timestamps[0] + windowMs - now) / 1000), 1);
}

function removeRunTimestamp(timestamp) {
  const index = runTimestamps.indexOf(timestamp);
  if (index !== -1) {
    runTimestamps.splice(index, 1);
  }
}

function pruneFailedTokenTimestamps(now) {
  const cutoff = now - FAILED_TOKEN_WINDOW_MS;
  while (failedTokenTimestamps.length && failedTokenTimestamps[0] <= cutoff) {
    failedTokenTimestamps.shift();
  }
}

function logRejectedRun(error, reason) {
  logger.error('Automations run rejected', {
    event: 'automations.run.rejected',
    reason,
    error: error.message,
  });
}

async function spawnPatrolSession(now) {
  const releaseSessionSlot = reserveSession();
  runTimestamps.push(now);
  try {
    const session = await createDevinSession(prompt, {
      title: 'Slow Query Patrol backtest',
    });
    if (!session) {
      const error = new Error('Devin session creation returned no session');
      error.reason = 'spawn_failed';
      throw error;
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
    return lastPatrolSession;
  } catch (error) {
    releaseSessionSlot();
    removeRunTimestamp(now);
    throw error;
  }
}

router.get('/automations', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/automations.html'));
});

router.post('/api/automations/run', async (req, res) => {
  try {
    const configuredToken = process.env.AUTOMATIONS_RUN_TOKEN;
    if (!configuredToken) {
      logger.warn('Automations run rejected', {
        event: 'automations.run.rejected',
        reason: 'not_configured',
      });
      return reject(res, 503, 'not_configured');
    }

    const now = Date.now();
    pruneFailedTokenTimestamps(now);
    const presentedToken = req.headers['x-automations-token'];
    if (!tokenMatches(presentedToken, configuredToken)) {
      if (failedTokenTimestamps.length >= FAILED_TOKEN_MAX) {
        const retryAfter = retryAfterSeconds(
          failedTokenTimestamps,
          FAILED_TOKEN_WINDOW_MS,
          now,
        );
        logger.warn('Automations run throttled after failed token attempts', {
          event: 'automations.run.throttled',
          retryAfterSeconds: retryAfter,
        });
        res.set('Retry-After', String(retryAfter));
        return reject(res, 429, 'throttled', { retryAfterSeconds: retryAfter });
      }
      failedTokenTimestamps.push(now);
      logger.warn('Automations run rejected', {
        event: 'automations.run.rejected',
        reason: 'forbidden',
      });
      return reject(res, 403, 'forbidden');
    }

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

    if (inFlightSpawn) {
      const session = await inFlightSpawn;
      logger.info('Automations run attached to in-flight session', {
        event: 'automations.run.attached',
        sessionId: session.sessionId,
      });
      return res.json({ success: true, ...session, attached: true });
    }

    if (runMaxPerHour <= 0 || runTimestamps.length >= runMaxPerHour) {
      const retryAfter = runTimestamps.length
        ? retryAfterSeconds(runTimestamps, RUN_WINDOW_MS, now)
        : 3600;
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

    const spawnPromise = spawnPatrolSession(now);
    inFlightSpawn = spawnPromise;
    try {
      const session = await spawnPromise;
      return res.json({ success: true, ...session, attached: false });
    } catch (error) {
      const reason = error.reason || 'error';
      logRejectedRun(error, reason);
      return reject(res, 500, reason);
    } finally {
      if (inFlightSpawn === spawnPromise) {
        inFlightSpawn = undefined;
      }
    }
  } catch (error) {
    const reason = error.reason || 'error';
    logRejectedRun(error, reason);
    return reject(res, 500, reason);
  }
});

module.exports = router;
module.exports.constants = {
  RUN_WINDOW_MS,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_ATTACH_WINDOW_MINUTES,
};

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../telemetry/logger');
const demo = require('../services/automations-demo');

const router = express.Router();
const CAP_WINDOW_MS = 60 * 60 * 1000;
const caps = new Map();
const CAP_LIMITS = {
  arm: 10,
  schedule: 10,
  declare: 10,
  stop: 20,
  smoke: 3,
  archive: 10,
};

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function demoCap(name) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${clientIp(req)}`;
    const timestamps = caps.get(key) || [];
    while (timestamps.length && timestamps[0] <= now - CAP_WINDOW_MS) timestamps.shift();
    if (timestamps.length >= CAP_LIMITS[name]) {
      const retryAfter = Math.max(
        Math.ceil((timestamps[0] + CAP_WINDOW_MS - now) / 1000),
        1,
      );
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: `Hourly limit reached for this action (${CAP_LIMITS[name]}/hour). Try again later.`,
      });
    }
    timestamps.push(now);
    caps.set(key, timestamps);
    next();
  };
}

function requireDemoToken(req, res, next) {
  const configured = process.env.AUTOMATIONS_DEMO_TOKEN;
  if (!configured) return next();
  const presented = req.headers['x-automations-demo-token']
    || req.headers['x-automations-token']
    || (typeof req.headers.authorization === 'string'
      && req.headers.authorization.replace(/^Bearer\s+/i, ''));
  if (!demo.tokenMatches(presented, configured)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

function errorResponse(res, error) {
  logger.error('Automations demo request failed', { error: error.message });
  return res.status(502).json({ ok: false, error: error.message });
}

router.use('/automations-demo', (_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

router.get('/automations-demo', (_req, res, next) => {
  const file = path.join(__dirname, '../public/automations-demo.html');
  fs.access(file, fs.constants.R_OK, (error) => {
    if (error) return next(error);
    res.sendFile(file);
  });
});

router.get('/api/automations-demo/status', async (_req, res) => {
  try {
    res.json(await demo.getStatus());
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/arm', requireDemoToken, demoCap('arm'), async (_req, res) => {
  try {
    const result = await demo.arm();
    const armedAt = result.armed_at || new Date().toISOString();
    res.json({
      ok: true,
      armedAt,
      nextFireAt: result.next_fire_at,
      guidance: 'Declare live at least 30–45 minutes after arm, once errors are flowing.',
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/schedule', requireDemoToken, demoCap('schedule'), (req, res) => {
  try {
    res.json(demo.schedule(req.body?.declareAt));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/declare', requireDemoToken, demoCap('declare'), async (_req, res) => {
  try {
    res.json(await demo.declare());
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/stop', requireDemoToken, demoCap('stop'), async (_req, res) => {
  try {
    res.json(await demo.stop('manual'));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/smoke', requireDemoToken, demoCap('smoke'), async (_req, res) => {
  try {
    const result = await demo.smoke();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/api/automations-demo/archive-stale', requireDemoToken, demoCap('archive'), async (_req, res) => {
  try {
    res.json(await demo.archiveStale());
  } catch (error) {
    return errorResponse(res, error);
  }
});

module.exports = router;

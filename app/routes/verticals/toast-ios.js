const express = require('express');
const {
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/toast-ios');
const live = require('../../services/verticals/toast-live');

const router = express.Router();
const LIVE_PATH = '/api/toast/live/:restaurant';

function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

function intFromEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function slidingWindow(max, windowMs) {
  const hits = [];
  return (now = Date.now()) => {
    while (hits.length > 0 && hits[0] < now - windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}

const REPORT_WINDOW_MS = intFromEnv('REPORT_CAP_TOAST_IOS_WINDOW_MINUTES', 10) * 60 * 1000;
const reserveReportSlot = slidingWindow(intFromEnv('REPORT_CAP_TOAST_IOS_MAX', 10), REPORT_WINDOW_MS);
const liveWriteLimits = new Map();
const LIVE_WRITES_PER_MINUTE = intFromEnv('TOAST_LIVE_WRITES_PER_MINUTE', 120);

function limitLiveWrites(req, res, next) {
  const key = req.ip || 'unknown';
  if (!liveWriteLimits.has(key)) {
    if (liveWriteLimits.size > 1000) liveWriteLimits.clear();
    liveWriteLimits.set(key, slidingWindow(LIVE_WRITES_PER_MINUTE, 60 * 1000));
  }
  if (!liveWriteLimits.get(key)()) return res.status(429).json({ error: 'RATE_LIMITED' });
  return next();
}

router.options(IOS_ERROR_PATH, allowCrossOrigin);
router.options(`${LIVE_PATH}/*rest`, allowCrossOrigin);

router.post(IOS_ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${APP_SOURCE_PREFIX}<platform> source with service ${APP_SERVICE}`,
    });
  }
  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      received: false, status: 'throttled', error: `Report cap reached for ${APP_SERVICE}; retry later`,
    });
  }
  const { reference } = reportAppFailure(body);
  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

router.get(`${LIVE_PATH}/menu`, allowCrossOrigin, (req, res) => {
  const menu = live.snapshot(req.params.restaurant);
  if (!menu) return res.status(404).json({ error: 'UNKNOWN_RESTAURANT' });
  return res.set('Cache-Control', 'no-store').json(menu);
});

router.post(`${LIVE_PATH}/ops`, allowCrossOrigin, limitLiveWrites, (req, res) => {
  const result = live.applyOp(req.params.restaurant, req.body && typeof req.body === 'object' ? req.body : {});
  return res.status(result.status).json(result.body);
});

router.post(`${LIVE_PATH}/log`, allowCrossOrigin, limitLiveWrites, (req, res) => {
  const result = live.addReply(req.params.restaurant, req.body && typeof req.body === 'object' ? req.body : {});
  return res.status(result.status).json(result.body);
});

router.post(`${LIVE_PATH}/reset`, allowCrossOrigin, limitLiveWrites, (req, res) => {
  const menu = live.reset(req.params.restaurant);
  if (!menu) return res.status(404).json({ error: 'UNKNOWN_RESTAURANT' });
  return res.json(menu);
});

router.get(`${LIVE_PATH}/stream`, allowCrossOrigin, (req, res) => {
  const opened = live.openStream(req.params.restaurant, res, {
    managerName: req.query.managerName, deviceId: req.query.deviceId, device: req.query.device,
  });
  if (!opened) return res.status(live.snapshot(req.params.restaurant) ? 503 : 404).json({ error: 'STREAM_UNAVAILABLE' });
  return undefined;
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;

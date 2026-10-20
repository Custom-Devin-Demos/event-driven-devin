const express = require('express');
const {
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/chapter-ios');

const router = express.Router();

// Native-only client (URLSession): no CORS headers, so browsers on other
// origins cannot post JSON reports here.
const parsedMax = parseInt(process.env.REPORT_CAP_CHAPTER_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_CHAPTER_IOS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

function retryAfterSeconds(now = Date.now()) {
  if (acceptedAt.length === 0) return 1;
  return Math.max(1, Math.ceil((acceptedAt[0] + REPORT_WINDOW_MS - now) / 1000));
}

router.post(IOS_ERROR_PATH, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${APP_SOURCE_PREFIX}<platform> source with service ${APP_SERVICE}`,
    });
  }

  const now = Date.now();
  if (!reserveReportSlot(now)) {
    res.set('Retry-After', String(retryAfterSeconds(now)));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${APP_SERVICE}; retry later`,
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

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
module.exports.retryAfterSeconds = retryAfterSeconds;

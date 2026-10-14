const express = require('express');
const {
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  findRecentReport,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/5b7227b4-gift-finder-ios');

const router = express.Router();

function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(IOS_ERROR_PATH, allowCrossOrigin);

const parsedMax = parseInt(process.env.REPORT_CAP_GIFT_FINDER_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_GIFT_FINDER_IOS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return now;
}

// A report whose alert/session was not delivered gives its slot back so retries stay possible.
function releaseReportSlot(at) {
  const index = acceptedAt.indexOf(at);
  if (index !== -1) acceptedAt.splice(index, 1);
}

// Seconds until the oldest accepted report leaves the window and a slot opens again.
function retryAfterSeconds(now = Date.now()) {
  const oldest = acceptedAt.length > 0 ? acceptedAt[0] : now;
  return Math.max(1, Math.ceil((oldest + REPORT_WINDOW_MS - now) / 1000));
}

/**
 * POST /api/5b7227b4/gift-finder/ios/error — a failed final reservation reported by the native
 * Nordstrom Gift Finder iOS app (COG-GTM/ios-demos, apps/nordstrom-gift-finder). Raises the Slack
 * alert and the Devin remediation session against the Swift repository.
 */
router.post(IOS_ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${APP_SOURCE_PREFIX}<platform> source with service ${APP_SERVICE}, an errorType and a recipient`,
    });
  }

  const duplicate = findRecentReport(body);
  if (duplicate) {
    return res.status(202).json({
      received: true,
      status: 'duplicate',
      reference: duplicate.reference,
      service: APP_SERVICE,
      sessionRequested: false,
      receivedAt: new Date().toISOString(),
    });
  }

  const slot = reserveReportSlot();
  if (slot === false) {
    res.set('Retry-After', String(retryAfterSeconds()));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${APP_SERVICE}; retry later`,
    });
  }

  const { reference, sessionPromise } = reportAppFailure(body);
  sessionPromise.then((delivered) => { if (!delivered) releaseReportSlot(slot); });

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
module.exports._resetReportCap = () => { acceptedAt.length = 0; };

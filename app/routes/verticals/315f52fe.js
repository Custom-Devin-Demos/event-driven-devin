const express = require('express');
const {
  APP_SERVICE,
  ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/315f52fe');

const router = express.Router();

// The GeForce NOW client is a native iOS app (github.com/Custom-Devin-Demos/
// nvidia-geforce-now-demo-app) — there is no hosted web build. /315f52fe
// (315f52fe.html, aliases /nvidia and /geforce-now) is a landing page that
// explains how to run the app and points at this endpoint.

// Native builds run from their own origin and skip CORS; a test harness that
// posts a FailureReport from a browser does preflight the JSON POST.
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

router.options(ERROR_PATH, allowCrossOrigin);

// The app cannot hold a secret (it ships in a public repo), so the route stays
// open like the other direct-report verticals; abuse is bounded by this
// per-route sliding window on top of the global Devin session cap.
const parsedMax = parseInt(process.env.REPORT_CAP_315F52FE_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_315F52FE_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

/**
 * POST /api/315f52fe/ios/error — `FailureReport` posted by the GeForce NOW
 * iOS app after Play threw. Raises the Slack alert and Devin session under
 * the app identity (customer-315f52fe-ios) with the identity the client
 * carried from sign-in (devinUserId / devinOrgId / devinEmail).
 */
router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a geforce-now-ios/<platform> source with service ${APP_SERVICE}`,
    });
  }

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
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

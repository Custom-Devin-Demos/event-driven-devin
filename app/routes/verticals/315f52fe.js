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

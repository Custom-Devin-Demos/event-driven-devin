const express = require('express');
const {
  APP_SERVICE,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/3aa9fa04');

const router = express.Router();

const ERROR_PATH = '/api/3aa9fa04/app/error';

// Expo Web serves the app from its own origin (e.g. localhost:8081), so the
// browser preflights this cross-origin JSON POST. Native iOS/Android skip CORS.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(ERROR_PATH, allowCrossOrigin);

/**
 * POST /api/3aa9fa04/app/error — failure reported by the Splash Sports mobile
 * app (github.com/COG-GTM/splash-sports-mobile) after one of its user actions
 * threw. Raises the Slack alert and Devin session under the mobile identity
 * (customer-3aa9fa04-mobile). There is no page for this vertical on this host.
 */
router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a splash-sports-mobile/<platform> source with service ${APP_SERVICE}`,
    });
  }

  const { reference } = reportAppFailure(body);

  return res.status(202).json({
    received: true,
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

module.exports = router;

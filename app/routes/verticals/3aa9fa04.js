const express = require('express');
const {
  APP_SERVICE,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/3aa9fa04');

const router = express.Router();

/**
 * POST /api/3aa9fa04/app/error — failure reported by the Splash Sports mobile
 * app (github.com/COG-GTM/splash-sports-mobile) after one of its user actions
 * threw. Raises the Slack alert and Devin session under the mobile identity
 * (customer-3aa9fa04-mobile). There is no page for this vertical on this host.
 */
router.post('/api/3aa9fa04/app/error', (req, res) => {
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

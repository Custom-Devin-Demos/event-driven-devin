const express = require('express');
const { getDashboard, runValidation } = require('../../services/verticals/c0e5ab62');
const logger = require('../../telemetry/logger');

const router = express.Router();

// `reports: 'off'` (or `?reports=off` on the page) runs the check but skips Slack/Devin; `x-synthetic` is local-only.
const reportsOff = (req) => req.body.reports === 'off'
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');

function fail(req, res, error) {
  logger.error('Migration validation request failed', {
    error: error.message, service: 'billing-migration', route: req.path, requestId: req.requestId,
  });
  res.status(500).json({ success: false, error: error.message, requestId: req.requestId });
}

router.get('/api/c0e5ab62/dashboard', (req, res) => {
  try {
    res.json(getDashboard());
  } catch (error) {
    fail(req, res, error);
  }
});

router.post('/api/c0e5ab62/validate', async (req, res) => {
  try {
    res.json(await runValidation({
      reportsOff: reportsOff(req),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    }));
  } catch (error) {
    fail(req, res, error);
  }
});

module.exports = router;

const express = require('express');
const logger = require('../../telemetry/logger');
const { processInquiry } = require('../../services/verticals/d5fc3172');

const router = express.Router();

router.get('/api/d5fc3172/plans', (_req, res) => {
  const { PLAN_TIERS, ADDON_CATALOG } = require('../../services/verticals/d5fc3172');
  res.json({ plans: PLAN_TIERS, addons: Object.keys(ADDON_CATALOG) });
});

router.post('/api/d5fc3172/inquiry', async (req, res) => {
  try {
    const result = await processInquiry({
      plan: req.body.plan || 'business',
      addons: req.body.addons || ['ai-companion', 'zoom-phone', 'zoom-rooms'],
      seats: req.body.seats || 200,
      region: req.body.region || 'na',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    logger.error('Inquiry endpoint error', {
      error: error.message,
      route: '/api/d5fc3172/inquiry',
    });
    res.status(500).json({
      error: error.message,
      errorClass: error.name || 'Error',
    });
  }
});

module.exports = router;

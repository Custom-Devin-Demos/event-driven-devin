const express = require('express');
const { processQuoteRequest, PLANS } = require('../../services/verticals/ad960e6a');

const router = express.Router();

/**
 * GET /api/ad960e6a/plans — returns available internet plan tiers
 */
router.get('/api/ad960e6a/plans', (_req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id,
      code: p.code,
      downloadMbps: p.downloadMbps,
      baseMonthly: p.baseMonthly,
    })),
  });
});

/**
 * POST /api/ad960e6a/quote — build a business internet quote
 */
router.post('/api/ad960e6a/quote', async (req, res) => {
  try {
    const result = await processQuoteRequest({
      plan: req.body.plan || 'standard',
      term: req.body.term || 12,
      solutions: req.body.solutions || [],
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

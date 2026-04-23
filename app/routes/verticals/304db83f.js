const express = require('express');
const { processAccountLookup, SUBSCRIBERS, PLAN_CATALOG } = require('../../services/verticals/304db83f');

const router = express.Router();

/**
 * GET /api/304db83f/plans — returns plan catalog and subscriber data
 */
router.get('/api/304db83f/plans', (_req, res) => {
  res.json({ plans: PLAN_CATALOG, subscribers: SUBSCRIBERS });
});

/**
 * POST /api/304db83f/account — run an account lookup
 */
router.post('/api/304db83f/account', async (req, res) => {
  try {
    const result = await processAccountLookup({
      email: req.body.email,
      subscriberId: req.body.subscriberId,
      promoCode: req.body.promoCode,
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
      code: error.code || 'ACCOUNT_LOOKUP_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

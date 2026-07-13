const express = require('express');
const { processPrequalification, OFFERS } = require('../../services/verticals/556bc104');

const router = express.Router();

/**
 * GET /api/556bc104/offers — returns available card offers
 */
router.get('/api/556bc104/offers', (_req, res) => {
  res.json({
    offers: Object.values(OFFERS).map((o) => ({
      code: o.code,
      partner: o.partner,
      product: o.product,
      apr: o.baseApr,
    })),
  });
});

/**
 * POST /api/556bc104/prequal — run a prequalification check
 */
router.post('/api/556bc104/prequal', async (req, res) => {
  try {
    const result = await processPrequalification({
      offerCode: req.body.offerCode || 'AE-REAL-REWARDS',
      channel: req.body.channel || 'web',
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
      code: error.code || 'PREQUAL_CHECK_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processRebalance, FUND_HOLDINGS, CONTRIBUTIONS } = require('../../services/verticals/766718e2');

const router = express.Router();

/**
 * GET /api/766718e2/funds — returns fund holdings and contribution history
 */
router.get('/api/766718e2/funds', (_req, res) => {
  res.json({ funds: FUND_HOLDINGS, contributions: CONTRIBUTIONS });
});

/**
 * POST /api/766718e2/rebalance — process a portfolio rebalance
 */
router.post('/api/766718e2/rebalance', async (req, res) => {
  try {
    const result = await processRebalance({
      accountId: req.body.accountId || 'ACCT-401K-7892',
      riskProfile: req.body.riskProfile || 'moderate',
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
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

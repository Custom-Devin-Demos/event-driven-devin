const express = require('express');

const router = express.Router();
const { processRebalance, FUNDS, ACTIVITY } = require('../../services/verticals/a30498ae');

/**
 * GET /api/a30498ae/portfolio — return fund holdings and recent activity
 */
router.get('/api/a30498ae/portfolio', (_req, res) => {
  res.json({
    funds: FUNDS,
    activity: ACTIVITY,
    totalBalance: FUNDS.reduce((sum, f) => sum + f.balance, 0),
  });
});

/**
 * POST /api/a30498ae/rebalance — rebalance 401(k) allocations
 */
router.post('/api/a30498ae/rebalance', async (req, res) => {
  try {
    const result = await processRebalance({
      riskProfile: req.body.riskProfile || 'moderate',
      contributionRate: req.body.contributionRate || 10,
      userId: req.body.userId || 'usr_401k_1',
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
      code: error.code || 'REBALANCE_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

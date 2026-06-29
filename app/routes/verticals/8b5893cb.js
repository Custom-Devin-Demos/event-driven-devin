const express = require('express');
const { rebalancePortfolio, HOLDINGS } = require('../../services/verticals/8b5893cb');

const router = express.Router();

/**
 * GET /api/8b5893cb/portfolio — returns managed-account holdings and totals
 */
router.get('/api/8b5893cb/portfolio', (_req, res) => {
  const totalValue = HOLDINGS.reduce((sum, h) => sum + h.marketValue, 0);
  res.json({
    holdings: HOLDINGS,
    totalValue: Math.round(totalValue * 100) / 100,
  });
});

/**
 * POST /api/8b5893cb/rebalance — execute a portfolio rebalance
 */
router.post('/api/8b5893cb/rebalance', async (req, res) => {
  try {
    const result = await rebalancePortfolio({
      accountId: req.body.accountId || 'TRP-MAA-204417',
      program: req.body.program || 'private-asset-mgmt',
      model: req.body.model || 'growth',
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
      code: error.code || 'REBALANCE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { executeTrade, PORTFOLIO } = require('../../services/verticals/financial-services');

const router = express.Router();

/**
 * GET /api/trading/portfolio — returns portfolio holdings
 */
router.get('/api/trading/portfolio', (_req, res) => {
  const totalValue = PORTFOLIO.reduce((sum, h) => sum + h.shares * h.currentPrice, 0);
  const totalCost = PORTFOLIO.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
  res.json({
    holdings: PORTFOLIO,
    totalValue: Math.round(totalValue * 100) / 100,
    totalGainLoss: Math.round((totalValue - totalCost) * 100) / 100,
  });
});

/**
 * POST /api/trading/execute — execute a trade
 */
router.post('/api/trading/execute', async (req, res) => {
  try {
    const result = await executeTrade({
      symbol: req.body.symbol || 'AAPL',
      side: req.body.side || 'buy',
      quantity: req.body.quantity || 10,
      price: req.body.price || 227.63,
      tierId: req.body.tierId || 1,
      accountId: req.body.accountId || 'ACCT-INV-001',
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
      code: error.code || 'TRADE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

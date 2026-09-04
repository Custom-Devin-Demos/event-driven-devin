const express = require('express');
const { submitRebalance, SECURITY_MASTER } = require('../../services/verticals/c7d11cb8');

const router = express.Router();

router.get('/api/c7d11cb8/securities', (_req, res) => {
  res.json({ securities: SECURITY_MASTER });
});

router.post('/api/c7d11cb8/rebalance', async (req, res) => {
  try {
    const result = await submitRebalance({
      accountId: req.body.accountId || 'MS-8842-01179',
      trades: req.body.trades || [{ symbol: 'VTI', side: 'buy', qty: 400, notional: 115764 }],
      notional: req.body.notional || 115764,
      programCode: req.body.programCode || 'SELECT_UMA',
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

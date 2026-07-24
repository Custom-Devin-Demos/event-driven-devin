const express = require('express');
const { executeOrder, SECURITIES } = require('../../services/verticals/ef58967c');

const router = express.Router();

router.get('/api/ef58967c/securities', (_req, res) => {
  res.json({ securities: SECURITIES });
});

router.post('/api/ef58967c/order', async (req, res) => {
  try {
    const result = await executeOrder({
      accountId: req.body.accountId || 'SCHW-00000000',
      symbol: req.body.symbol || 'AAPL',
      side: req.body.side || 'sell',
      quantity: req.body.quantity || 100,
      orderType: req.body.orderType || 'market',
      region: req.body.region || 'US',
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

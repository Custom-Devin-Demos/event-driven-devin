const express = require('express');
const {
  processRedemption,
  ACCOUNTS,
  TRANSACTIONS,
  REWARD_TIERS,
} = require('../../services/verticals/49d841e8');

const router = express.Router();

router.get('/api/49d841e8/summary', (_req, res) => {
  res.json({
    accounts: ACCOUNTS,
    recentTransactions: TRANSACTIONS,
    rewardTiers: REWARD_TIERS,
  });
});

router.post('/api/49d841e8/redeem', async (req, res) => {
  try {
    const result = await processRedemption({
      account: req.body.account || 'CARTAO-2290',
      cardProduct: req.body.cardProduct || 'ultravioleta',
      amount: req.body.amount || 312.99,
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
      code: error.code || 'REDEMPTION_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

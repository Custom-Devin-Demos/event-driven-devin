const express = require('express');
const { processRewardsCheck, CARD_PRODUCTS, RECENT_REWARDS } = require('../../services/verticals/barclays');

const router = express.Router();

/**
 * GET /api/barclays/cards — returns card products and recent rewards
 */
router.get('/api/barclays/cards', (_req, res) => {
  res.json({ cards: CARD_PRODUCTS, recentRewards: RECENT_REWARDS });
});

/**
 * POST /api/barclays/rewards — process a rewards check
 */
router.post('/api/barclays/rewards', async (req, res) => {
  try {
    const result = await processRewardsCheck({
      cardType: req.body.cardType || 'visa-signature',
      statementPeriod: req.body.statementPeriod || '2026-03',
      monthlySpend: req.body.monthlySpend || 2500,
      rewardsTier: req.body.rewardsTier || 'platinum',
      userId: req.body.userId || 'usr_barclays_1',
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INVALID_CARD' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

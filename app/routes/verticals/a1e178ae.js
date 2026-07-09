const express = require('express');
const { bookTrade, COMMODITIES } = require('../../services/verticals/a1e178ae');

const router = express.Router();

/**
 * GET /api/a1e178ae/commodities — returns the tradable commodity book
 */
router.get('/api/a1e178ae/commodities', (_req, res) => {
  res.json({ commodities: COMMODITIES });
});

/**
 * POST /api/a1e178ae/book — book a physical commodity export contract
 */
router.post('/api/a1e178ae/book', async (req, res) => {
  try {
    const result = await bookTrade({
      trader: req.body.trader || 'LDC Brazil Desk',
      lots: Array.isArray(req.body.lots) ? req.body.lots : [],
      contractValue: Number(req.body.contractValue) || 0,
      volumeMt: Number(req.body.volumeMt) || 0,
      terminal: req.body.terminal || 'santos',
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

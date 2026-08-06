const express = require('express');
const {
  CORRIDORS,
  processGlobalAccountQuote,
} = require('../../services/verticals/b98fcab6');

const router = express.Router();

router.get('/api/b98fcab6/corridors', (_req, res) => {
  res.json({
    corridors: Object.entries(CORRIDORS).map(([pair, details]) => ({
      pair,
      ...details,
    })),
  });
});

router.post('/api/b98fcab6/global-account', async (req, res) => {
  try {
    const result = await processGlobalAccountQuote({
      corridor: req.body.corridor || 'usd-brl',
      amount: req.body.amount || 2500,
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
      code: error.code || 'GLOBAL_ACCOUNT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

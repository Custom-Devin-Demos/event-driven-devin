const express = require('express');
const {
  checkAvailability,
  SECURITIES,
  LENDER_SCOPES,
} = require('../../services/verticals/f3e617ec');

const router = express.Router();

router.get('/api/f3e617ec/securities', (req, res) => {
  res.json({
    securities: Object.entries(SECURITIES).map(([ticker, security]) => ({
      ticker,
      label: security.label,
      isin: security.isin,
      market: security.market,
    })),
    lenderScopes: Object.entries(LENDER_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      lenderCount: scope.lenders.length,
    })),
  });
});

router.post('/api/f3e617ec/availability-check', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkAvailability({
      ticker: body.ticker,
      quantity: body.quantity,
      scope: body.scope,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'AVAILABILITY_CHECK_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processStoreSearch, MARKET_DIRECTORY } = require('../../services/verticals/3c3e0371');

const router = express.Router();

router.get('/api/3c3e0371/markets', (_req, res) => {
  res.json({
    markets: Object.values(MARKET_DIRECTORY).map((m) => ({
      code: m.code,
      label: m.label,
    })),
  });
});

router.post('/api/3c3e0371/store-search', async (req, res) => {
  try {
    const result = await processStoreSearch({
      zip: req.body.zip || '75201',
      fulfillment: req.body.fulfillment || 'in-store',
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
      code: error.code || 'STORE_SEARCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processQuoteRequest, PRODUCTS } = require('../../services/verticals/382b34fc');

const router = express.Router();

/**
 * GET /api/382b34fc/products — returns available insurance products
 */
router.get('/api/382b34fc/products', (_req, res) => {
  res.json({
    products: Object.entries(PRODUCTS).map(([id, p]) => ({
      id,
      code: p.code,
      name: p.name,
      basePremium: p.basePremium,
      coverage: p.coverage,
    })),
  });
});

/**
 * POST /api/382b34fc/quote — build an insurance quote
 */
router.post('/api/382b34fc/quote', async (req, res) => {
  try {
    const result = await processQuoteRequest({
      product: req.body.product || 'auto',
      drivers: req.body.drivers || 1,
      addons: req.body.addons || [],
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
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

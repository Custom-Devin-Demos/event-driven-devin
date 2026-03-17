const express = require('express');
const { processOrder, CATALOG } = require('../../services/verticals/cpg');

const router = express.Router();

/**
 * GET /api/cpg/catalog — returns the product catalog
 */
router.get('/api/cpg/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * POST /api/cpg/order — place a distributor bulk order
 */
router.post('/api/cpg/order', async (req, res) => {
  try {
    const result = await processOrder({
      distributorId: req.body.distributorId || 'DIST-001',
      region: req.body.region || 'northeast',
      fulfillmentZone: req.body.fulfillmentZone || 'southeast',
      items: req.body.items || [{ sku: 'BEV-001', qty: 50 }],
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

const express = require('express');
const { processPreorder, PRODUCTS } = require('../../services/verticals/f2f54159');

const router = express.Router();

/**
 * GET /api/f2f54159/catalog — return the collectibles product catalog
 */
router.get('/api/f2f54159/catalog', (_req, res) => {
  res.json({ products: PRODUCTS });
});

/**
 * POST /api/f2f54159/preorder — place a collectibles pre-order
 */
router.post('/api/f2f54159/preorder', async (req, res) => {
  try {
    const result = await processPreorder({
      sku: req.body.sku || 'ML-001',
      quantity: req.body.quantity || 1,
      region: req.body.region || 'northeast',
      shippingPreference: req.body.shippingPreference || 'standard',
      productLine: req.body.productLine || 'marvel-legends',
      email: req.body.email || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PREORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

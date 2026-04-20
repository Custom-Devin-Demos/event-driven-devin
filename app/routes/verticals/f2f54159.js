const express = require('express');
const { processPreorder, PRODUCT_LINES, SHIPPING_REGIONS } = require('../../services/verticals/f2f54159');

const router = express.Router();

/**
 * GET /api/f2f54159/catalog — returns product lines and shipping regions
 */
router.get('/api/f2f54159/catalog', (_req, res) => {
  res.json({ productLines: PRODUCT_LINES, shippingRegions: Object.keys(SHIPPING_REGIONS) });
});

/**
 * POST /api/f2f54159/preorder — submit a pre-order request
 */
router.post('/api/f2f54159/preorder', async (req, res) => {
  try {
    const result = await processPreorder({
      firstName: req.body.firstName || '',
      lastName: req.body.lastName || '',
      email: req.body.email,
      productLine: req.body.productLine || 'marvel-legends',
      quantity: parseInt(req.body.quantity, 10) || 1,
      region: req.body.region || 'us-contiguous',
      membership: req.body.membership || 'standard',
      devinEmail: req.body.devinEmail,
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

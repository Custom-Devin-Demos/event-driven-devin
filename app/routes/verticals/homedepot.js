const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/homedepot');

const router = express.Router();

router.get('/api/homedepot/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/homedepot/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'HD-1001-DRILL', qty: 1, price: 159.0 }],
      subtotal: req.body.subtotal || 159.0,
      region: req.body.region || 'US',
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
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/cocacola');

const router = express.Router();

router.get('/api/cocacola/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/cocacola/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'COKE-CLS-12', qty: 1, price: 8.49 }],
      subtotal: req.body.subtotal || 8.49,
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

const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/walgreens');

const router = express.Router();

router.get('/api/walgreens/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/walgreens/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'WAG-TYL-XS', qty: 1, price: 12.99 }],
      subtotal: req.body.subtotal || 12.99,
      region: req.body.region || 'IL',
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

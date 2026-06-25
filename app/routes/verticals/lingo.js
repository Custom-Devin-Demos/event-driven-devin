const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/lingo');

const router = express.Router();

router.get('/api/lingo/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/lingo/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [
        { sku: 'LIN-SHAPE-4W', qty: 1, price: 89.00 },
        { sku: 'LIN-PATCH-10', qty: 1, price: 15.00 },
      ],
      subtotal: req.body.subtotal || 104.00,
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

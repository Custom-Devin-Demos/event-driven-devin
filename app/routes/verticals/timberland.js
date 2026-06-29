const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/timberland');

const router = express.Router();

router.get('/api/timberland/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/timberland/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'TBL-PREM-6IN', qty: 1, price: 228.00 }],
      subtotal: req.body.subtotal || 228.00,
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

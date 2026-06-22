const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/macys');

const router = express.Router();

router.get('/api/macys/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/macys/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'MCY-INC-DRS', qty: 1, price: 119.50 }],
      subtotal: req.body.subtotal || 119.50,
      region: req.body.region || 'NY',
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

const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/12b28f14');

const router = express.Router();

router.get('/api/12b28f14/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/12b28f14/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'PEP-CLS-12', qty: 1, price: 7.99 }],
      subtotal: req.body.subtotal || 7.99,
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

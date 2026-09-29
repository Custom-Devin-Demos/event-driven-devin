const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/4e150e99');

const router = express.Router();

router.get('/api/4e150e99/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/4e150e99/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'VZ-DEV-IP17P-256', qty: 1, price: 45.83 }],
      subtotal: req.body.subtotal || 45.83,
      state: req.body.state || 'NY',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

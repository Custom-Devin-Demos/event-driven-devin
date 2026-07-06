const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/43f2f084');

const router = express.Router();

router.get('/api/43f2f084/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/43f2f084/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'GAP-MC-TEE', qty: 1, price: 19.95 }],
      subtotal: req.body.subtotal || 19.95,
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

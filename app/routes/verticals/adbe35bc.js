const express = require('express');
const { processCheckout, CATALOG } = require('../../services/verticals/adbe35bc');

const router = express.Router();

router.get('/api/adbe35bc/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/adbe35bc/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'RGR-DEV-IP17P-256', qty: 1, price: 56.25 }],
      subtotal: req.body.subtotal || 56.25,
      province: req.body.province || 'ON',
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

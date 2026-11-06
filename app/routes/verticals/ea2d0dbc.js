const express = require('express');
const { CATALOG, placeOrder } = require('../../services/verticals/ea2d0dbc');
const router = express.Router();

router.get('/api/ea2d0dbc/catalog', (_req, res) => {
  res.json({ products: CATALOG.map(({ shippingClass: _shippingClass, ...product }) => product) });
});

router.post('/api/ea2d0dbc/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await placeOrder({
      items: body.items,
      promoCode: body.promoCode,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;

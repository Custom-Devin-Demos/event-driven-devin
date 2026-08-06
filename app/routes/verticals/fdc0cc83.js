const express = require('express');
const { placeOrder, CATALOG } = require('../../services/verticals/fdc0cc83');

const router = express.Router();

router.get('/api/fdc0cc83/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/fdc0cc83/order', async (req, res) => {
  try {
    const result = await placeOrder({
      customerId: req.body.customerId || 'anonymous',
      storeId: req.body.storeId || 'STORE-5260',
      items: req.body.items || [{ sku: 'WMT-GV-MILK', qty: 1, price: 3.48 }],
      subtotal: req.body.subtotal || 3.48,
      state: req.body.state || 'AR',
      fulfillmentMethod: req.body.fulfillmentMethod || 'express',
      membership: req.body.membership || 'plus',
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

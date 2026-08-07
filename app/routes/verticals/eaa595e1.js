const express = require('express');
const { placeOrder, CATALOG } = require('../../services/verticals/eaa595e1');

const router = express.Router();

router.get('/api/eaa595e1/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/eaa595e1/order', async (req, res) => {
  try {
    const result = await placeOrder({
      customerId: req.body.customerId || 'anonymous',
      storeId: req.body.storeId || 'STORE-01400',
      items: req.body.items || [{ sku: 'KRO-ST-MILK', qty: 1, price: 5.49 }],
      subtotal: req.body.subtotal || 5.49,
      state: req.body.state || 'OH',
      fulfillmentMethod: req.body.fulfillmentMethod || 'delivery',
      membership: req.body.membership || 'boost-annual',
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

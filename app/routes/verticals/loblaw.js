const express = require('express');
const { processGroceryOrder, CATALOG } = require('../../services/verticals/loblaw');

const router = express.Router();

router.get('/api/loblaw/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/loblaw/checkout', async (req, res) => {
  try {
    const result = await processGroceryOrder({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'GRO-KETCH-750', qty: 1, price: 5.00 }],
      subtotal: req.body.subtotal || 5.00,
      fulfillment: req.body.fulfillment || 'PICKUP',
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

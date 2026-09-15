const express = require('express');
const { processCheckout, lookupOrder, CATALOG } = require('../../services/verticals/50b235c7');

const router = express.Router();

router.get('/api/50b235c7/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/50b235c7/checkout', async (req, res) => {
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'LLL-ALIGN-25', qty: 1, price: 98.00 }],
      subtotal: req.body.subtotal || 98.00,
      region: req.body.region || 'US',
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

router.post('/api/50b235c7/order-status', async (req, res) => {
  try {
    const result = await lookupOrder({
      orderNumber: req.body.orderNumber,
      sessionToken: req.body.sessionToken || 'sess_demo_avery',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_STATUS_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

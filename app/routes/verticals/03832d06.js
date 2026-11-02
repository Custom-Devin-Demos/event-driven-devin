const express = require('express');
const {
  placeOrder, CATALOG, SHELVES, STORE, FULFILLMENT, TAX_RATE, DELIVERY_FEE, DELIVERY_FREE_MIN, MAX_LINE_QTY, MAX_CART_LINES,
} = require('../../services/verticals/03832d06');

const router = express.Router();

/**
 * GET /api/03832d06/catalog — carousel items, shelves, store and fee schedule
 */
router.get('/api/03832d06/catalog', (_req, res) => {
  res.json({
    products: CATALOG,
    shelves: SHELVES,
    store: STORE,
    fulfillment: FULFILLMENT,
    fees: { taxRate: TAX_RATE, deliveryFee: DELIVERY_FEE, deliveryFreeMin: DELIVERY_FREE_MIN },
    maxLineQty: MAX_LINE_QTY,
    maxCartLines: MAX_CART_LINES,
  });
});

/**
 * POST /api/03832d06/checkout — place the cart as a pickup or delivery order
 */
router.post('/api/03832d06/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      fulfillment: body.fulfillment,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(order);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
      quantumMetric: error.quantumMetric,
    });
  }
});

module.exports = router;

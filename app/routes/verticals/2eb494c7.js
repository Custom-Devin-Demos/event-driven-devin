const express = require('express');
const {
  placeOrder, STORE, MENU, SIZES, SIDES, DRINKS, DROP_OFF_OPTIONS, PAYMENT_METHODS,
  DELIVERY_FEE, SERVICE_FEE_RATE, TAX_RATE,
} = require('../../services/verticals/2eb494c7');

const router = express.Router();

/**
 * GET /api/2eb494c7/menu — store, menu items, meal modifiers and checkout options
 */
router.get('/api/2eb494c7/menu', (_req, res) => {
  res.json({
    store: STORE,
    items: MENU,
    modifiers: {
      sizes: Object.values(SIZES),
      sides: Object.values(SIDES),
      drinks: Object.values(DRINKS),
    },
    dropOffOptions: Object.values(DROP_OFF_OPTIONS),
    paymentMethods: Object.values(PAYMENT_METHODS),
    fees: { deliveryFee: DELIVERY_FEE, serviceFeeRate: SERVICE_FEE_RATE, taxRate: TAX_RATE },
  });
});

/**
 * POST /api/2eb494c7/order — place the McDelivery order
 */
router.post('/api/2eb494c7/order', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      address: body.address,
      dropOff: body.dropOff || 'leave_at_door',
      dropOffNote: body.dropOffNote,
      schedule: body.schedule || 'asap',
      tip: body.tip,
      paymentMethod: body.paymentMethod || 'card',
      promoCode: body.promoCode,
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

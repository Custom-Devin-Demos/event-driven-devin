const express = require('express');
const {
  placeOrder,
  CATALOG,
  STORES,
  MYDG_MEMBER,
} = require('../../services/verticals/59c53533');

const router = express.Router();

// Reproduction mode lets a remediation session fail the order on camera without
// re-raising the incident it was created from. It is ignored in production, so the
// header cannot silence a real Dollar General failure on the hosted demo.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/dollar-general/catalog', (_req, res) => {
  res.json({
    products: Object.values(CATALOG),
    stores: Object.values(STORES).map((store) => ({ storeNumber: store.storeNumber, address: store.address })),
    member: { firstName: MYDG_MEMBER.firstName, freeDeliveriesRemaining: MYDG_MEMBER.freeDeliveriesRemaining, deliveryAddress: MYDG_MEMBER.deliveryAddress },
  });
});

router.post('/api/dollar-general/checkout', async (req, res) => {
  const body = req.body || {};

  try {
    const order = await placeOrder({
      items: body.items,
      fulfillment: body.fulfillment,
      storeId: body.storeId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(order);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_ORDER',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'CHECKOUT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

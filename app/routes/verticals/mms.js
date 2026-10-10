const express = require('express');
const {
  getCart, estimateShipping, applyPromo, checkout,
} = require('../../services/verticals/mms');

const router = express.Router();

function identity(body) {
  return {
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
  };
}

function sendError(res, req, error, fallbackCode) {
  const status = error.statusCode === 400 ? 400 : 500;
  res.status(status).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: req.requestId,
  });
}

router.get('/api/mms/cart', (_req, res) => {
  res.json(getCart());
});

router.post('/api/mms/shipping-estimate', (req, res) => {
  const body = req.body || {};
  try {
    res.json(estimateShipping({ items: body.items, zip: body.zip }));
  } catch (error) {
    sendError(res, req, error, 'SHIPPING_ESTIMATE_FAILED');
  }
});

router.post('/api/mms/promo', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await applyPromo({ items: body.items, code: body.code, ...identity(body) }));
  } catch (error) {
    sendError(res, req, error, 'PROMO_FAILED');
  }
});

router.post('/api/mms/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await checkout({
      items: body.items,
      zip: body.zip,
      shippingMethod: body.shippingMethod,
      promoCode: body.promoCode,
      ...identity(body),
    }));
  } catch (error) {
    sendError(res, req, error, 'CHECKOUT_FAILED');
  }
});

module.exports = router;

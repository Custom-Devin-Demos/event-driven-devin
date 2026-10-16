const express = require('express');
const { placeOrder, PRODUCT, FRIENDS_AND_FAMILY } = require('../../services/verticals/2b43150a');

const router = express.Router();

// Reproduction mode lets a remediation session fail the checkout on camera without
// re-raising the incident it was created from. Ignored in production.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/2b43150a/product', (_req, res) => {
  res.json({ product: PRODUCT, promotion: FRIENDS_AND_FAMILY });
});

router.post('/api/2b43150a/checkout', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await placeOrder({
      variantId: body.variantId,
      size: body.size,
      fit: body.fit,
      quantity: body.quantity,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_CHECKOUT',
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

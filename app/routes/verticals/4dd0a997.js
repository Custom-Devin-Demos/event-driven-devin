const express = require('express');
const {
  checkout,
  publicCustomer,
  CATALOG,
  CUSTOMERS,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_SKU,
} = require('../../services/verticals/4dd0a997');

const router = express.Router();

// Reproduction mode lets a remediation session fail the request on camera without
// re-raising the incident it was created from. It is ignored in production, so the
// header cannot silence a real failure on the hosted demo.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/best-buy/storefront', (_req, res) => {
  res.json({
    product: CATALOG[DEFAULT_SKU],
    customers: Object.values(CUSTOMERS).map(publicCustomer),
    defaultCustomerId: DEFAULT_CUSTOMER_ID,
  });
});

router.post('/api/best-buy/checkout', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await checkout({
      customerId: body.customerId,
      items: body.items,
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
        code: error.code || 'INVALID_REQUEST',
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

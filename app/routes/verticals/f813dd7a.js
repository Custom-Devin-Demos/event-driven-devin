const express = require('express');
const { placeOrder, CATALOG } = require('../../services/verticals/f813dd7a');

const router = express.Router();

/**
 * GET /api/f813dd7a/catalog — products available on the storefront
 */
router.get('/api/f813dd7a/catalog', (_req, res) => {
  res.json({
    products: CATALOG.map((product) => ({
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      price: product.price,
    })),
  });
});

/**
 * POST /api/f813dd7a/checkout — place the shopping bag order
 */
router.post('/api/f813dd7a/checkout', async (req, res) => {
  try {
    const order = await placeOrder({
      items: req.body.items && req.body.items.length
        ? req.body.items
        : [{ sku: 'GAP-441020', qty: 1, shippingMethod: 'standard' }],
      promoCode: req.body.promoCode || 'FRIENDS40',
      zipCode: req.body.zipCode || '10011',
      channel: req.body.channel || 'web',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(order);
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

module.exports = router;

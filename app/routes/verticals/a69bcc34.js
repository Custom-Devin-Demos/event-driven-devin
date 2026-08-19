const express = require('express');
const { placeOrder, CATALOG } = require('../../services/verticals/a69bcc34');

const router = express.Router();

/**
 * GET /api/a69bcc34/catalog — products available on the storefront
 */
router.get('/api/a69bcc34/catalog', (_req, res) => {
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
 * POST /api/a69bcc34/checkout — place the online cart order
 */
router.post('/api/a69bcc34/checkout', async (req, res) => {
  try {
    const order = await placeOrder({
      items: req.body.items && req.body.items.length
        ? req.body.items
        : [{ sku: '1005643790', qty: 1, fulfillment: 'delivery' }],
      promoCode: req.body.promoCode || 'HDCC25',
      storeNumber: req.body.storeNumber || '6177',
      zipCode: req.body.zipCode || '10010',
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

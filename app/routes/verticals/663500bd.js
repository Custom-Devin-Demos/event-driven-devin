const express = require('express');
const { placeOrder, CATALOG, MEMBERSHIP_TIERS } = require('../../services/verticals/663500bd');

const router = express.Router();

/**
 * GET /api/663500bd/bag — items in the shopping bag
 */
router.get('/api/663500bd/bag', (_req, res) => {
  res.json({
    items: CATALOG.map((product) => ({
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      price: product.price,
      color: product.color,
      size: product.size,
    })),
  });
});

/**
 * GET /api/663500bd/tiers — Nordy Club membership tiers
 */
router.get('/api/663500bd/tiers', (_req, res) => {
  res.json({
    tiers: Object.entries(MEMBERSHIP_TIERS).map(([id, tier]) => ({
      id,
      label: tier.label,
    })),
  });
});

/**
 * POST /api/663500bd/checkout — place the bag order
 */
router.post('/api/663500bd/checkout', async (req, res) => {
  const body = req.body || {};

  try {
    const order = await placeOrder({
      items: Array.isArray(body.items)
        ? body.items
        : [{ sku: '7846231', qty: 1 }],
      membershipTier: body.membershipTier || 'icon',
      shippingMethod: body.shippingMethod || 'standard',
      storeNumber: body.storeNumber || '0013',
      channel: body.channel || 'web',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(order);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

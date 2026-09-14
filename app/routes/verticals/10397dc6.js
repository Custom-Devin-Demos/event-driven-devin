const express = require('express');
const {
  placeOrder, CATALOG, STORES, FULFILMENT_METHODS, TENDERS, BONUS_EVENTS,
} = require('../../services/verticals/10397dc6');

const router = express.Router();

/**
 * GET /api/10397dc6/catalog — products, stores, fulfilment options and bonus events
 */
router.get('/api/10397dc6/catalog', (_req, res) => {
  res.json({
    products: CATALOG.map((product) => ({
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      category: product.category,
      price: product.price,
      wasPrice: product.wasPrice,
      image: product.image,
    })),
    stores: Object.values(STORES),
    fulfilment: Object.values(FULFILMENT_METHODS),
    tenders: Object.values(TENDERS).map(({ code, label }) => ({ code, label })),
    bonusEvents: Object.values(BONUS_EVENTS).map(({ code, label, multiplier }) => ({ code, label, multiplier })),
  });
});

/**
 * POST /api/10397dc6/checkout — place the Triangle Rewards order
 */
router.post('/api/10397dc6/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      promoCode: body.promoCode ?? 'BTTS30X',
      tender: body.tender || 'triangle-mastercard',
      fulfilment: body.fulfilment || 'ship-to-home',
      storeId: body.storeId || 'ON-0128',
      postalCode: body.postalCode || 'M4M 3G3',
      channel: body.channel || 'web',
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
    });
  }
});

module.exports = router;

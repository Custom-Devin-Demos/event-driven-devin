const express = require('express');
const {
  processCheckout,
  findProduct,
  CATALOG,
  STATE_TAX,
  SHIPPING_METHODS,
  SCORECARD_TIERS,
} = require('../../services/verticals/b66a0397');

const router = express.Router();
const MAX_CART_LINES = 20;

function badRequest(res, error) {
  return res.status(400).json({ success: false, error, errorClass: 'ValidationError', code: 'VALIDATION_ERROR' });
}

router.get('/api/b66a0397/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/b66a0397/checkout', async (req, res) => {
  const body = req.body || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const state = typeof body.state === 'string' ? body.state.trim().toUpperCase() : 'PA';
  const shippingMethod = typeof body.shippingMethod === 'string' ? body.shippingMethod : 'standard';
  const scorecardTier = typeof body.scorecardTier === 'string' ? body.scorecardTier : 'gold';

  if (rawItems.length === 0) return badRequest(res, 'Your cart is empty');
  if (rawItems.length > MAX_CART_LINES) return badRequest(res, `Cart cannot exceed ${MAX_CART_LINES} items`);
  if (!Object.hasOwn(STATE_TAX, state)) return badRequest(res, `Unsupported ship-to state: ${state}`);
  if (!Object.hasOwn(SHIPPING_METHODS, shippingMethod)) return badRequest(res, `Unknown shipping method: ${shippingMethod}`);
  if (!Object.hasOwn(SCORECARD_TIERS, scorecardTier)) return badRequest(res, `Unknown ScoreCard tier: ${scorecardTier}`);

  const items = [];
  for (const line of rawItems) {
    const product = findProduct(line && line.sku);
    const qty = Number(line && line.qty);
    if (!product) return badRequest(res, `Unknown item: ${line && line.sku}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) return badRequest(res, `Invalid quantity for ${product.id}`);
    items.push({ sku: product.id, qty, price: product.price });
  }

  try {
    const result = await processCheckout({
      userId: typeof body.userId === 'string' ? body.userId : 'anonymous',
      items,
      state,
      shippingMethod,
      scorecardTier,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

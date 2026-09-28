const express = require('express');
const {
  placeOrder, findProduct, findMember, CATALOG, STORES, SHIPPING,
} = require('../../services/verticals/1b17e823');

const router = express.Router();

router.get('/api/1b17e823/catalog', (_req, res) => {
  res.json({
    products: CATALOG.map(({ sku, name, brand, price, color, size }) => ({ sku, name, brand, price, color, size })),
  });
});

function validationError(res, req, message) {
  return res.status(400).json({ success: false, error: message, errorClass: 'ValidationError', code: 'INVALID_CART', requestId: req.requestId });
}

router.post('/api/1b17e823/checkout', async (req, res) => {
  const body = req.body || {};
  const requested = Array.isArray(body.items) && body.items.length
    ? body.items
    : [{ sku: '24NIKMPGSS41RDXXXRNN', qty: 1 }, { sku: '20SPAUTF1000LGCYBSKB', qty: 1 }];

  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && findProduct(item.sku);
    if (!product) return validationError(res, req, `Unknown SKU: ${item && item.sku}`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1) return validationError(res, req, `Quantity for ${product.sku} must be a positive integer`);
    qtyBySku.set(product.sku, (qtyBySku.get(product.sku) || 0) + qty);
  }
  for (const [sku, qty] of qtyBySku) {
    const { limitPerOrder } = findProduct(sku);
    if (qty > limitPerOrder) return validationError(res, req, `Quantity for ${sku} must be between 1 and ${limitPerOrder}`);
  }
  const items = [...qtyBySku].map(([sku, qty]) => ({ sku, qty }));

  const memberId = body.memberId || 'SC-8841207733';
  if (memberId !== 'guest' && !findMember(memberId)) return validationError(res, req, `Unknown ScoreCard member: ${memberId}`);
  const fulfillment = body.fulfillment || 'ship';
  if (!SHIPPING[fulfillment]) return validationError(res, req, `Unsupported fulfillment method: ${fulfillment}`);
  const storeNumber = body.storeNumber || '0212';
  if (!STORES[storeNumber]) return validationError(res, req, `Unknown store: ${storeNumber}`);
  const submittedZip = String(body.zipCode || STORES[storeNumber].zipCode);
  if (!/^\d{5}$/.test(submittedZip)) return validationError(res, req, 'ZIP code must be 5 digits');
  const zipCode = fulfillment === 'pickup' ? STORES[storeNumber].zipCode : submittedZip;

  try {
    const order = await placeOrder({
      items,
      memberId,
      fulfillment,
      storeNumber,
      zipCode,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
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

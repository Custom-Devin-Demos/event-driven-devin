const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { listProducts, getProduct, startApplication } = require('../../services/verticals/ddb178db');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sendError(res, req, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/ddb178db/card-offers', (_req, res) => {
  res.json({ success: true, offers: listProducts() });
});

router.get('/api/ddb178db/card-offers/:productId', (req, res) => {
  const product = getProduct(text(req.params.productId, 60));
  if (!product) {
    res.status(404).json({ success: false, error: 'Unknown card product', code: 'CARD_PRODUCT_NOT_FOUND', requestId: req.requestId });
    return;
  }
  res.json({ success: true, offer: product });
});

router.post('/api/ddb178db/card-offers/:productId/applications', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startApplication({
      productId: text(req.params.productId, 60),
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, req, error, 'CARD_APPLICATION_FAILED');
  }
});

module.exports = router;

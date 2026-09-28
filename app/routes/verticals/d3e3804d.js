const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { getCatalog, checkout } = require('../../services/verticals/d3e3804d');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

router.get('/api/d3e3804d/catalog', (_req, res) => {
  res.json({ success: true, ...getCatalog() });
});

router.post('/api/d3e3804d/checkout', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const order = await checkout({
      items: Array.isArray(body.items) ? body.items : [],
      zip: text(body.zip, 10),
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
    });
    res.json({ success: true, order });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

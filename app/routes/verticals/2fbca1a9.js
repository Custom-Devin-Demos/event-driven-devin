const express = require('express');
const {
  quoteCoverage,
  PRODUCTS,
  PROVINCES,
  QUOTE_CHANNELS,
} = require('../../services/verticals/2fbca1a9');

const router = express.Router();

router.get('/api/2fbca1a9/quote-options', (req, res) => {
  res.json({
    products: Object.entries(PRODUCTS).map(([key, product]) => ({ key, label: product.label })),
    provinces: Object.entries(PROVINCES).map(([key, province]) => ({ key, label: province.label })),
    channels: Object.entries(QUOTE_CHANNELS).map(([key, channel]) => ({
      key,
      label: channel.label,
      products: Array.isArray(channel.programs) ? Object.keys(PRODUCTS) : Object.keys(channel.programs),
    })),
  });
});

router.post('/api/2fbca1a9/coverage-quote', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await quoteCoverage({
      product: body.product,
      province: body.province,
      postalCode: body.postalCode,
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COVERAGE_QUOTE_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

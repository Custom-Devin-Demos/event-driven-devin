const express = require('express');
const { submitInquiry, PRODUCTS } = require('../../services/verticals/63f3f711');

const router = express.Router();

/**
 * GET /api/63f3f711/products — product lines available for inquiry
 */
router.get('/api/63f3f711/products', (_req, res) => {
  res.json({
    products: Object.values(PRODUCTS).map((product) => ({
      code: product.code,
      name: product.name,
      description: product.description,
    })),
  });
});

/**
 * POST /api/63f3f711/inquiry — submit a sales inquiry
 */
router.post('/api/63f3f711/inquiry', async (req, res) => {
  try {
    const summary = await submitInquiry({
      product: req.body.product || 'payments',
      country: req.body.country || 'US',
      estimatedMonthlyUsd: req.body.estimatedMonthlyUsd,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(summary);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

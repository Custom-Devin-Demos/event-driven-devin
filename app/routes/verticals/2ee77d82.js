const express = require('express');
const { submitInquiry, BRANDS } = require('../../services/verticals/2ee77d82');

const router = express.Router();

/**
 * GET /api/2ee77d82/brands — restaurant brand portfolio
 */
router.get('/api/2ee77d82/brands', (_req, res) => {
  res.json({
    brands: Object.values(BRANDS).map((brand) => ({
      code: brand.code,
      name: brand.name,
      category: brand.category,
      restaurants: brand.restaurants,
    })),
  });
});

/**
 * POST /api/2ee77d82/inquiry — submit a corporate inquiry
 */
router.post('/api/2ee77d82/inquiry', async (req, res) => {
  try {
    const summary = await submitInquiry({
      topic: req.body.topic || 'investor-relations',
      market: req.body.market || 'US',
      source: req.body.source,
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

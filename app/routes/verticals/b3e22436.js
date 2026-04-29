const express = require('express');
const { processInquiry, LICENSE_TIERS, CLOUD_PRODUCTS } = require('../../services/verticals/b3e22436');

const router = express.Router();

/**
 * GET /api/b3e22436/components — returns license tiers and cloud products
 */
router.get('/api/b3e22436/components', (_req, res) => {
  res.json({ tiers: LICENSE_TIERS, products: CLOUD_PRODUCTS });
});

/**
 * POST /api/b3e22436/inquiry — process a platform inquiry
 */
router.post('/api/b3e22436/inquiry', async (req, res) => {
  try {
    const result = await processInquiry({
      tier: req.body.tier || 'enterprise',
      region: req.body.region || 'americas',
      products: req.body.products || ['sales', 'service', 'agentforce'],
      seats: req.body.seats || 150,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
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

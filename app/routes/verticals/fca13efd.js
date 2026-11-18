const express = require('express');
const { PRODUCTS, PLATFORMS, REGIONS, submitBuyNow } = require('../../services/verticals/fca13efd');
const router = express.Router();

router.get('/api/fca13efd/catalog', (_req, res) => res.json({ products: PRODUCTS, platforms: PLATFORMS, regions: REGIONS }));

router.post('/api/fca13efd/buy-now', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitBuyNow({
      order: body.order,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'BUY_NOW_FAILED', requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

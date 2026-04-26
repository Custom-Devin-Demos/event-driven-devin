const express = require('express');
const { runInquiry, REGIONS, LOAN_PRODUCTS } = require('../../services/verticals/4feeb7bb');

const router = express.Router();

/**
 * GET /api/4feeb7bb/components — returns region and loan product data
 */
router.get('/api/4feeb7bb/components', (_req, res) => {
  res.json({ regions: REGIONS, products: LOAN_PRODUCTS });
});

/**
 * POST /api/4feeb7bb/inquiry — run a mortgage rate inquiry
 */
router.post('/api/4feeb7bb/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      loanType: req.body.loanType || 'mortgage',
      region: req.body.region || 'stockholm',
      rateType: req.body.rateType || 'variable',
      productId: req.body.productId,
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

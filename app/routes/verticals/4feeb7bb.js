const express = require('express');
const { runInquiry, BRANCHES, MORTGAGE_PRODUCTS } = require('../../services/verticals/4feeb7bb');

const router = express.Router();

/**
 * GET /api/4feeb7bb/products — returns mortgage products and branch data
 */
router.get('/api/4feeb7bb/products', (_req, res) => {
  res.json({ branches: BRANCHES, products: MORTGAGE_PRODUCTS });
});

/**
 * POST /api/4feeb7bb/inquiry — run a mortgage rate inquiry
 */
router.post('/api/4feeb7bb/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      region: req.body.region || 'stockholm',
      loanType: req.body.loanType || 'all',
      principal: req.body.principal || 500000,
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

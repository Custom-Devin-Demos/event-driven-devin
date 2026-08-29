const express = require('express');
const { processAccountInquiry, PRODUCT_CATALOG } = require('../../services/verticals/4b7e1d37');

const router = express.Router();

/**
 * GET /api/4b7e1d37/products — deposit products open for online application
 */
router.get('/api/4b7e1d37/products', (_req, res) => {
  res.json({
    products: PRODUCT_CATALOG.map((p) => ({
      productCode: p.productCode,
      name: p.name,
      category: p.category,
      monthlyFee: p.monthlyFee,
    })),
  });
});

/**
 * POST /api/4b7e1d37/inquiry — start an account-opening inquiry
 */
router.post('/api/4b7e1d37/inquiry', async (req, res) => {
  try {
    const result = await processAccountInquiry({
      productCode: req.body.productCode || 'vw-checking',
      zipCode: req.body.zipCode || '15222',
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
      code: error.code || 'ACCOUNT_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

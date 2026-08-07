const express = require('express');
const { openAccount, PRODUCTS } = require('../../services/verticals/3cec99d4');

const router = express.Router();

/**
 * GET /api/3cec99d4/products — deposit products offered in the online application
 */
router.get('/api/3cec99d4/products', (_req, res) => {
  res.json({
    products: PRODUCTS.map((product) => ({
      code: product.code,
      name: product.name,
      type: product.type,
      monthlyFee: product.monthlyFee,
    })),
  });
});

/**
 * POST /api/3cec99d4/open-account — start an online deposit-account application
 */
router.post('/api/3cec99d4/open-account', async (req, res) => {
  try {
    const application = await openAccount({
      productCode: req.body.productCode || 'ADV-STUDENT-CHQ',
      applicantType: req.body.applicantType || 'student-full-time',
      promoCode: req.body.promoCode || 'STUDENT-AIRPODS-2026',
      province: req.body.province || 'ON',
      channel: req.body.channel || 'web',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(application);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCOUNT_APPLICATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

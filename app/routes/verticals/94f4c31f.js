const express = require('express');
const { submitPersonalInfo, PRODUCTS } = require('../../services/verticals/94f4c31f');

const router = express.Router();

/**
 * GET /api/94f4c31f/products — brokerage products offered in the online application
 */
router.get('/api/94f4c31f/products', (_req, res) => {
  res.json({
    products: PRODUCTS.map((product) => ({
      code: product.code,
      name: product.name,
      type: product.type,
      accountMinimum: product.accountMinimum,
    })),
  });
});

/**
 * POST /api/94f4c31f/personal-info — submit the Personal Information step
 */
router.post('/api/94f4c31f/personal-info', async (req, res) => {
  try {
    const result = await submitPersonalInfo({
      productCode: req.body.productCode || 'SELF-INVEST',
      firstName: req.body.firstName || '',
      lastName: req.body.lastName || '',
      dateOfBirth: req.body.dateOfBirth,
      channel: req.body.channel || 'web',
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
      code: error.code || 'APPLICATION_STEP_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

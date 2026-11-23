const express = require('express');
const {
  submitContactRequest,
  BUSINESS_TYPES,
  PRODUCT_INTERESTS,
  PREFILL,
  LATENCY_SLO,
} = require('../../services/verticals/7c3e9a52');

const router = express.Router();

router.get('/api/7c3e9a52/config', (_req, res) => {
  res.json({
    success: true,
    options: {
      businessTypes: BUSINESS_TYPES,
      productInterests: PRODUCT_INTERESTS,
    },
    prefill: PREFILL,
    budgetMs: LATENCY_SLO.budgetMs,
  });
});

router.post('/api/7c3e9a52/contact-requests', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitContactRequest({
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company,
      email: body.email,
      phone: body.phone,
      businessType: body.businessType,
      productInterest: body.productInterest,
      message: body.message,
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
      code: error.code || 'CONTACT_REQUEST_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

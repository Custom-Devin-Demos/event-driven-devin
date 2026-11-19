const express = require('express');
const {
  submitDemoRequest,
  ORGANIZATION_TYPES,
  COMPANY_SIZES,
  COUNTRIES,
  PREFILL,
  LATENCY_SLO,
} = require('../../services/verticals/65ee9e8f');

const router = express.Router();

router.get('/api/65ee9e8f/config', (_req, res) => {
  res.json({
    success: true,
    options: {
      organizationTypes: ORGANIZATION_TYPES,
      companySizes: COMPANY_SIZES,
      countries: COUNTRIES,
    },
    prefill: PREFILL,
    budgetMs: LATENCY_SLO.budgetMs,
  });
});

router.post('/api/65ee9e8f/demo-requests', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitDemoRequest({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      company: body.company,
      jobTitle: body.jobTitle,
      country: body.country,
      phone: body.phone,
      organizationType: body.organizationType,
      companySize: body.companySize,
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
      code: error.code || 'DEMO_REQUEST_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

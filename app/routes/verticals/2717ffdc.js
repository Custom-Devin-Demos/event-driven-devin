const express = require('express');
const {
  submitDemoRequest,
  BUSINESS_TYPES,
  PREFILL,
  LATENCY_SLO,
} = require('../../services/verticals/2717ffdc');

const router = express.Router();

router.get('/api/2717ffdc/config', (_req, res) => {
  res.json({
    success: true,
    options: {
      businessTypes: BUSINESS_TYPES,
    },
    prefill: PREFILL,
    budgetMs: LATENCY_SLO.budgetMs,
  });
});

router.post('/api/2717ffdc/demo-requests', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitDemoRequest({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      businessType: body.businessType,
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

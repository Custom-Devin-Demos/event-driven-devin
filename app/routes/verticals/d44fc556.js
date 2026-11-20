const express = require('express');
const {
  submitEnquiry,
  ENQUIRY_TYPES,
  COUNTRIES,
  PREFILL,
  RELATIONSHIP_DESKS,
  LATENCY_SLO,
} = require('../../services/verticals/d44fc556');

const router = express.Router();

router.get('/api/d44fc556/config', (_req, res) => {
  res.json({
    success: true,
    options: {
      enquiryTypes: ENQUIRY_TYPES,
      countries: COUNTRIES,
    },
    prefill: PREFILL,
    budgetMs: LATENCY_SLO.budgetMs,
  });
});

router.get('/api/d44fc556/offices', (_req, res) => {
  res.json({
    success: true,
    offices: RELATIONSHIP_DESKS.map(({ office, name }) => ({ office, desk: name })),
  });
});

router.post('/api/d44fc556/enquiries', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitEnquiry({
      enquiryType: body.enquiryType,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company,
      country: body.country,
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
      code: error.code || 'ENQUIRY_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

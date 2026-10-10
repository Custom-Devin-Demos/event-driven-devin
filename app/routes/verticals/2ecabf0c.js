const express = require('express');
const {
  matchSpecialists,
  COMPANIES,
  ROUTING_OPTIONS,
  INDUSTRIES,
} = require('../../services/verticals/2ecabf0c');

const router = express.Router();

router.get('/api/2ecabf0c/companies', (req, res) => {
  res.json({
    companies: COMPANIES.map(({ key, label, serviceLine }) => ({ key, label, serviceLine })),
    routingOptions: Object.entries(ROUTING_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      companyCount: option.companies.length,
    })),
    industries: Object.entries(INDUSTRIES).map(([key, industry]) => ({ key, label: industry.label })),
  });
});

router.post('/api/2ecabf0c/specialist-match', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await matchSpecialists({
      businessName: body.businessName,
      email: body.email,
      industry: body.industry,
      routing: body.routing,
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
      code: error.code || 'SPECIALIST_MATCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const {
  previewPayRun,
  COUNTRIES,
  SCOPE_OPTIONS,
} = require('../../services/verticals/b1e1bd35');

const router = express.Router();

router.get('/api/b1e1bd35/countries', (req, res) => {
  res.json({
    countries: COUNTRIES.map(({
      code, country, flag, currency, provider,
    }) => ({
      code, country, flag, currency, provider,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      countryCount: option.countries.length,
    })),
  });
});

router.post('/api/b1e1bd35/pay-run-preview', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await previewPayRun({
      companyName: body.companyName,
      email: body.email,
      scope: body.scope,
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
      code: error.code || 'PAY_RUN_PREVIEW_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

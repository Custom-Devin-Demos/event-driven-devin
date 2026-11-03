const express = require('express');
const {
  runRevenueCycleAssessment,
  PAYERS,
  SCOPE_OPTIONS,
  FACILITY_TYPES,
} = require('../../services/verticals/85bedc75');

const router = express.Router();

router.get('/api/85bedc75/payers', (req, res) => {
  res.json({
    payers: Object.entries(PAYERS).map(([key, payer]) => ({
      key,
      label: payer.label,
      line: payer.line,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      payerCount: option.payers.length,
    })),
    facilityTypes: Object.entries(FACILITY_TYPES).map(([key, facility]) => ({
      key,
      label: facility.label,
    })),
  });
});

router.post('/api/85bedc75/ar-assessment', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runRevenueCycleAssessment({
      organization: body.organization,
      facilityType: body.facilityType,
      annualNprMillions: body.annualNprMillions,
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
      code: error.code || 'AR_ASSESSMENT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

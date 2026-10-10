const express = require('express');
const {
  runComplianceCheck,
  FRAMEWORKS,
  SCOPE_OPTIONS,
} = require('../../services/verticals/8f970d35');

const router = express.Router();

router.get('/api/8f970d35/frameworks', (req, res) => {
  res.json({
    frameworks: Object.entries(FRAMEWORKS).map(([key, framework]) => ({
      key,
      label: framework.label,
      name: framework.name,
      domain: framework.domain,
      controls: framework.controls,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      frameworkCount: option.frameworks.length,
    })),
  });
});

router.post('/api/8f970d35/compliance-check', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runComplianceCheck({
      organization: body.organization,
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
      code: error.code || 'COMPLIANCE_CHECK_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

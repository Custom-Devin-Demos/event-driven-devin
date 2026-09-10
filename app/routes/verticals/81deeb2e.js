const express = require('express');
const {
  provisionEnvironment,
  SOLUTION_PACKAGES,
  REGIONS,
} = require('../../services/verticals/81deeb2e');

const router = express.Router();

router.get('/api/81deeb2e/catalog', (_req, res) => {
  res.json({
    packages: Object.entries(SOLUTION_PACKAGES).map(([code, pkg]) => ({
      code,
      label: pkg.label,
      audience: pkg.audience,
      annualList: pkg.annualList,
      services: pkg.services,
    })),
    regions: Object.entries(REGIONS).map(([code, region]) => ({ code, label: region.label })),
  });
});

router.post('/api/81deeb2e/environments', async (req, res) => {
  const environmentName = (req.body.environmentName || '').trim();
  const identityCount = parseInt(req.body.identityCount, 10);

  if (!environmentName) {
    return res.status(400).json({ success: false, error: 'environmentName is required', code: 'VALIDATION_ERROR' });
  }
  if (!Number.isFinite(identityCount) || identityCount <= 0) {
    return res.status(400).json({ success: false, error: 'identityCount must be a positive integer', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await provisionEnvironment({
      environmentName,
      solutionPackage: req.body.solutionPackage || 'customers_plus',
      region: req.body.region || 'na',
      identityCount,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ENVIRONMENT_PROVISION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

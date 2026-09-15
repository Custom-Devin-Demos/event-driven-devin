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

const ENVIRONMENT_TYPES = ['production', 'sandbox'];

router.post('/api/81deeb2e/environments', async (req, res) => {
  const environmentName = (req.body.environmentName || '').trim();
  const identityCount = Number(req.body.identityCount);
  const solutionPackage = req.body.solutionPackage || 'customers_plus';
  const region = req.body.region || 'na';
  const environmentType = req.body.environmentType || 'production';

  if (!environmentName) {
    return res.status(400).json({ success: false, error: 'environmentName is required', code: 'VALIDATION_ERROR' });
  }
  if (!Number.isSafeInteger(identityCount) || identityCount <= 0) {
    return res.status(400).json({ success: false, error: 'identityCount must be a positive integer', code: 'VALIDATION_ERROR' });
  }
  if (!SOLUTION_PACKAGES[solutionPackage]) {
    return res.status(400).json({ success: false, error: `Unknown solution package: ${solutionPackage}`, code: 'VALIDATION_ERROR' });
  }
  if (!REGIONS[region]) {
    return res.status(400).json({ success: false, error: `Unknown region: ${region}`, code: 'VALIDATION_ERROR' });
  }
  if (!ENVIRONMENT_TYPES.includes(environmentType)) {
    return res.status(400).json({ success: false, error: `environmentType must be one of: ${ENVIRONMENT_TYPES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await provisionEnvironment({
      environmentName,
      solutionPackage,
      region,
      environmentType,
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

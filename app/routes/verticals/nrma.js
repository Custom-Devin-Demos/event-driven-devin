const express = require('express');
const path = require('path');
const {
  submitClaim,
  POLICIES,
} = require('../../services/verticals/nrma');

const router = express.Router();

router.get('/nrma', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'nrma.html'));
});

router.get('/api/nrma/policies', (_req, res) => {
  res.json({
    policies: Object.values(POLICIES),
  });
});

router.post('/api/nrma/claim', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const claim = await submitClaim({
      policyNumber: valueOrDefault('policyNumber', 'NRMA-HM-7741820'),
      incidentType: valueOrDefault('incidentType', 'storm'),
      incidentDate: valueOrDefault('incidentDate', '2026-09-12'),
      estimatedRepairCost: valueOrDefault('estimatedRepairCost', 18400),
      damageDescription: valueOrDefault(
        'damageDescription',
        'Severe hailstorm on 12 September cracked roof tiles above the main bedroom and water came through the ceiling. Bedroom carpet and a built-in wardrobe are soaked.',
      ),
      affectedItems: valueOrDefault(
        'affectedItems',
        'Roof tiles, bedroom ceiling, carpet, built-in wardrobe',
      ),
      makeSafeRequired: valueOrDefault('makeSafeRequired', true),
      contactNumber: valueOrDefault('contactNumber', '0412 884 190'),
      policyholderDeclaration: valueOrDefault('policyholderDeclaration', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(claim);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_CLAIM_REQUEST',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_LODGEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

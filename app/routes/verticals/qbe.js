const express = require('express');
const path = require('path');
const { submitClaim, POLICIES } = require('../../services/verticals/qbe');

const router = express.Router();

router.get('/qbe', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'qbe.html'));
});

router.get('/api/qbe/policies', (_req, res) => {
  res.json({
    policies: Object.values(POLICIES).map((policy) => ({
      policyNumber: policy.policyNumber,
      insuredName: policy.insuredName,
      coverageTierLabel: policy.coverageTierLabel,
      vehicles: policy.vehicles,
    })),
  });
});

router.post('/api/qbe/claim', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const claim = await submitClaim({
      policyNumber: valueOrDefault('policyNumber', 'QBE-PA-4417293'),
      incidentType: valueOrDefault('incidentType', 'collision'),
      incidentDate: valueOrDefault('incidentDate', '2026-08-21'),
      damageDescription: valueOrDefault(
        'damageDescription',
        'The insured vehicle sustained front-end damage in a collision.',
      ),
      vin: valueOrDefault('vin', '1HGCV1F34LA015872'),
      photoCount: valueOrDefault('photoCount', 0),
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
        code: error.code || 'INVALID_CLAIM',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

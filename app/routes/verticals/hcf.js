const express = require('express');
const path = require('path');
const { submitClaim, MEMBERSHIPS } = require('../../services/verticals/hcf');

const router = express.Router();

router.get('/hcf', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'hcf.html'));
});

router.get('/api/hcf/memberships', (_req, res) => {
  res.json({
    memberships: Object.entries(MEMBERSHIPS).map(([membershipNumber, membership]) => ({
      membershipNumber,
      memberName: membership.memberName,
      coverTierLabel: membership.coverTierLabel,
      people: membership.people,
    })),
  });
});

router.post('/api/hcf/claim', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  const claimData = {
    membershipNumber: valueOrDefault('membershipNumber', 'HCF-8815427'),
    personId: valueOrDefault('personId', 'P01'),
    serviceType: valueOrDefault('serviceType', 'dental'),
    serviceDate: valueOrDefault('serviceDate', '2026-08-24'),
    providerName: valueOrDefault('providerName', 'Bondi Junction Dental Care'),
    providerNumber: valueOrDefault('providerNumber', '0451234A'),
    receiptCount: valueOrDefault('receiptCount', 0),
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
  };

  if (Object.prototype.hasOwnProperty.call(body, 'feeCharged')) {
    claimData.feeCharged = body.feeCharged;
  }

  try {
    const claim = await submitClaim(claimData);
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
      code: error.code || 'CLAIM_BENEFIT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

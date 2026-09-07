const express = require('express');
const path = require('path');
const { submitClaim, MEMBERSHIPS } = require('../../services/verticals/ausunity');

const router = express.Router();

router.get('/ausunity', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'ausunity.html'));
});

router.get('/api/ausunity/memberships', (_req, res) => {
  res.json({
    memberships: Object.values(MEMBERSHIPS).map((membership) => ({
      membershipNumber: membership.membershipNumber,
      memberName: membership.memberName,
      productLabel: membership.productLabel,
      persons: membership.persons,
    })),
  });
});

router.post('/api/ausunity/claim', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const claim = await submitClaim({
      membershipNumber: valueOrDefault('membershipNumber', 'AU-HI-7731942'),
      claimCategory: valueOrDefault('claimCategory', 'hospital'),
      serviceDate: valueOrDefault('serviceDate', '2026-08-28'),
      providerName: valueOrDefault('providerName', 'Epworth Richmond'),
      amount: valueOrDefault('amount', 4850),
      personId: valueOrDefault('personId', 'P1'),
      receiptCount: valueOrDefault('receiptCount', 0),
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
      code: error.code || 'CLAIM_ASSESSMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

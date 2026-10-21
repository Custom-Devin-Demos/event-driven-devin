const express = require('express');
const { submitClaim, ValidationError, MEMBER, POLICIES } = require('../../services/verticals/f0c109ee');

const router = express.Router();

router.get('/api/f0c109ee/coverage', (_req, res) => {
  res.json({
    member: MEMBER,
    policies: Object.entries(POLICIES).map(([policyId, policy]) => ({
      policyId,
      claimType: policy.claimType,
      planName: policy.planName,
      coverageTier: policy.coverageTier,
      status: policy.status,
    })),
  });
});

router.post('/api/f0c109ee/claims', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitClaim({
      policyId: body.policyId,
      claimType: body.claimType,
      amount: body.amount,
      description: body.description,
      serviceDate: body.serviceDate,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    const status = error instanceof ValidationError ? 400 : 500;
    res.status(status).json({
      success: false,
      error: status === 400 ? error.message : 'We couldn\u2019t submit your claim right now. Please try again in a few minutes.',
      errorClass: error.name,
      claimId: error.claimId || null,
      requestId: error.claimId || req.requestId || null,
    });
  }
});

module.exports = router;

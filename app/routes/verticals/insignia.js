const express = require('express');
const path = require('path');
const {
  submitAllocation,
  MEMBER_ACCOUNTS,
  INVESTMENT_OPTIONS,
} = require('../../services/verticals/insignia');

const router = express.Router();

router.get('/insignia', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'insignia.html'));
});

router.get('/api/insignia/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(MEMBER_ACCOUNTS).map((account) => ({
      memberAccountId: account.memberAccountId,
      memberNumber: account.memberNumber,
      memberName: account.memberName,
      accountName: account.accountName,
      productLabel: account.productLabel,
      accountBalance: account.accountBalance,
      employer: account.employer,
    })),
    investmentOptions: Object.values(INVESTMENT_OPTIONS).map((option) => ({
      optionId: option.optionId,
      name: option.name,
      assetClass: option.assetClass,
      growthWeighting: option.growthWeighting,
      managementFee: option.managementFee,
    })),
  });
});

router.post('/api/insignia/allocation', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  const allocationData = {
    memberAccountId: valueOrDefault('memberAccountId', '4471902883'),
    contributionType: valueOrDefault('contributionType', 'employer_sg'),
    effectiveDate: valueOrDefault('effectiveDate', '2026-09-08'),
    allocations: valueOrDefault('allocations', [
      { optionId: 'OPT-BAL', percentage: 60 },
      { optionId: 'OPT-GRW', percentage: 30 },
      { optionId: 'OPT-CASH', percentage: 10 },
    ]),
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
    channel: body.channel,
  };

  try {
    const allocation = await submitAllocation(allocationData);
    res.json(allocation);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_ALLOCATION',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ALLOCATION_UPDATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

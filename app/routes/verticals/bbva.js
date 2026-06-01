const express = require('express');
const { processApplication, ACCOUNT_TYPES } = require('../../services/verticals/bbva');

const router = express.Router();

router.get('/api/bbva/products', (_req, res) => {
  const products = Object.entries(ACCOUNT_TYPES).map(([id, spec]) => ({
    id,
    monthlyFee: spec.monthlyFee,
    minIncome: spec.minIncome,
    interestRate: spec.interestRate + '%',
  }));
  res.json({ products });
});

router.post('/api/bbva/apply', async (req, res) => {
  try {
    const result = await processApplication({
      applicantType: req.body.applicantType || 'personal',
      accountType: req.body.accountType || 'cuenta-online',
      income: req.body.income || 30000,
      employmentYears: req.body.employmentYears || 3,
      region: req.body.region || 'madrid',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INVALID_ACCOUNT_TYPE' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

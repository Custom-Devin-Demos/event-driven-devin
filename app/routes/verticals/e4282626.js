const express = require('express');
const { compareRates, PLAN_TYPES } = require('../../services/verticals/e4282626');

const router = express.Router();

router.get('/api/e4282626/plans', (_req, res) => {
  res.json({
    plans: Object.entries(PLAN_TYPES).map(([code, plan]) => ({
      code,
      label: plan.label,
      preferredCarrier: plan.preferredCarrier,
      deductibleUsd: plan.deductibleUsd,
    })),
  });
});

router.post('/api/e4282626/inquiry', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await compareRates({
      zip: body.zip,
      planCode: body.planCode || 'G',
      age: body.age || 65,
      tobacco: body.tobacco || false,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RATE_LOOKUP_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

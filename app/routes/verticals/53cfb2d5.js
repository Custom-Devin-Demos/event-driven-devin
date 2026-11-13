const express = require('express');
const {
  checkCoverage,
  CARRIERS,
  US_STATES,
} = require('../../services/verticals/53cfb2d5');

const router = express.Router();

router.get('/api/53cfb2d5/carriers', (req, res) => {
  res.json({
    carriers: Object.entries(CARRIERS).map(([key, carrier]) => ({
      key,
      label: carrier.label,
      planCount: carrier.plans.length,
    })),
    states: US_STATES,
  });
});

router.post('/api/53cfb2d5/coverage-check', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkCoverage({
      firstName: body.firstName,
      lastName: body.lastName,
      dateOfBirth: body.dateOfBirth,
      state: body.state,
      carrier: body.carrier,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COVERAGE_CHECK_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processEnrollment, PLAN_CATALOG, STATES } = require('../../services/verticals/9fdcf315');

const router = express.Router();

router.get('/api/9fdcf315/plans', (_req, res) => {
  res.json({ plans: PLAN_CATALOG, states: Object.keys(STATES) });
});

router.post('/api/9fdcf315/enroll', async (req, res) => {
  try {
    const result = await processEnrollment({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [
        { planId: 'ANT-MED-GOLD-PPO', premium: 612.40 },
        { planId: 'ANT-DEN-ESSENTIAL', premium: 38.20 },
        { planId: 'ANT-VIS-BLUEVIEW', premium: 12.60 },
      ],
      state: req.body.state || 'IN',
      household: req.body.household || [
        { relationship: 'self', age: 41 },
        { relationship: 'spouse', age: 39 },
        { relationship: 'child', age: 8 },
      ],
      coverageStart: req.body.coverageStart === undefined ? '2027-01-01' : req.body.coverageStart,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ENROLLMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

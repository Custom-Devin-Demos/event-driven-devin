const express = require('express');
const router = express.Router();
const { processSignup, PLANS, REGIONS } = require('../../services/verticals/99a8ba1a');

router.get('/api/99a8ba1a/config', (_req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, monthlyFee: p.monthlyFee })),
    regions: Object.entries(REGIONS).map(([code, r]) => ({ code, name: r.name })),
  });
});

router.post('/api/99a8ba1a/signup', async (req, res) => {
  try {
    const result = await processSignup({
      plan: req.body.plan || 'rider',
      region: req.body.region || 'us-west',
      promoCode: req.body.promoCode,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'PLAN_NOT_FOUND' || error.code === 'REGION_UNAVAILABLE' ? 422 : 500;
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

const express = require('express');
const path = require('path');
const { buildMoneyPlan } = require('../../services/verticals/2589dca4');

const router = express.Router();

// Reproduction mode lets a remediation session fail the request on camera without
// re-raising the incident it was created from. Ignored in production.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/2589dca4', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '2589dca4.html'));
});

router.post('/api/2589dca4/money-plan', async (req, res) => {
  const body = req.body || {};

  try {
    const plan = await buildMoneyPlan({
      profileId: body.profileId || 'everyday-smart-access',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(plan);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'MoneyPlanError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_MONEY_PLAN_REQUEST',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'MONEY_PLAN_BUILD_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

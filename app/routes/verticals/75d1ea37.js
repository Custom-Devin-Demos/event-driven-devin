const express = require('express');
const { estimatePlans } = require('../../services/verticals/75d1ea37');

const router = express.Router();

/**
 * POST /api/75d1ea37/plan-estimates — AGL "Compare electricity and gas plans"
 * address lookup: resolves the supply point and prices every residential plan.
 */
router.post('/api/75d1ea37/plan-estimates', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await estimatePlans({
      address: body.address || '12 Harris Street, Pyrmont NSW 2009',
      electricity: body.electricity !== false,
      gas: body.gas !== false,
      solar: body.solar === true,
      electricVehicle: body.electricVehicle === true,
      period: body.period || 'yearly',
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
      code: error.code || 'PLAN_ESTIMATE_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

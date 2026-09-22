const express = require('express');
const {
  lookupCoverage,
  estimateVisitCost,
  MEMBERS,
  SERVICES,
  RECENT_CLAIMS,
} = require('../../services/verticals/7c6a6ef9');

const router = express.Router();

/**
 * GET /api/7c6a6ef9/context — members, in-network services and recent claims
 */
router.get('/api/7c6a6ef9/context', (_req, res) => {
  res.json({
    members: MEMBERS.map(({ id, name, email }) => ({ id, name, email })),
    services: SERVICES.map(({ id, label, allowedAmount }) => ({ id, label, allowedAmount })),
    recentClaims: RECENT_CLAIMS,
  });
});

/**
 * POST /api/7c6a6ef9/coverage — member coverage status, deductible progress and cost sharing
 */
router.post('/api/7c6a6ef9/coverage', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await lookupCoverage({
      email: body.email,
      memberId: body.memberId,
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
      code: error.code || 'COVERAGE_LOOKUP_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/7c6a6ef9/cost-estimate — member cost for an in-network service before the visit
 */
router.post('/api/7c6a6ef9/cost-estimate', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await estimateVisitCost({
      email: body.email,
      memberId: body.memberId,
      serviceId: body.serviceId,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COST_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

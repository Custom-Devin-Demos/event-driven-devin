const express = require('express');
const { processClaim, POLICIES, CLAIM_TYPES } = require('../../services/verticals/insurance');

const router = express.Router();

/**
 * GET /api/insurance/policies — returns policies and claim types
 */
router.get('/api/insurance/policies', (_req, res) => {
  res.json({ policies: POLICIES, claimTypes: CLAIM_TYPES });
});

/**
 * POST /api/insurance/claim — submit an insurance claim
 */
router.post('/api/insurance/claim', async (req, res) => {
  try {
    const result = await processClaim({
      policyId: req.body.policyId || 'POL-5001',
      claimType: req.body.claimType || 'collision',
      amount: req.body.amount || 5000,
      description: req.body.description || 'Vehicle damage from collision',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

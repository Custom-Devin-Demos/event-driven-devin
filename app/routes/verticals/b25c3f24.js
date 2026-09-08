const express = require('express');
const { verifyIdentity, PAYMENT_PLANS } = require('../../services/verticals/b25c3f24');

const router = express.Router();

/**
 * GET /api/b25c3f24/plans — returns Affirm pay-over-time plans
 */
router.get('/api/b25c3f24/plans', (_req, res) => {
  res.json({ plans: PAYMENT_PLANS });
});

/**
 * POST /api/b25c3f24/verify-identity — verifies the shopper's identity
 */
router.post('/api/b25c3f24/verify-identity', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await verifyIdentity({
      planId: body.planId || 'plan-12',
      ssnLast4: body.ssnLast4,
      orderTotal: body.orderTotal || 1944.39,
      merchant: body.merchant || 'brilliant-earth',
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
      code: error.code || 'IDENTITY_VERIFICATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

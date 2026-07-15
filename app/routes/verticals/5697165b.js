const express = require('express');
const { processDeliveryEstimate, SHIPPING_METHODS } = require('../../services/verticals/5697165b');

const router = express.Router();

/**
 * GET /api/5697165b/shipping-methods — returns the shipping method catalog
 */
router.get('/api/5697165b/shipping-methods', (_req, res) => {
  res.json({
    methods: SHIPPING_METHODS.map((m) => ({
      id: m.id,
      label: m.label,
      zones: m.zones,
    })),
  });
});

/**
 * POST /api/5697165b/delivery-estimate — get a delivery cost and arrival estimate
 */
router.post('/api/5697165b/delivery-estimate', async (req, res) => {
  try {
    const result = await processDeliveryEstimate({
      methodId: req.body.methodId || 'standard',
      region: req.body.region || 'alaska-hawaii',
      orderTotal: req.body.orderTotal || 129,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DELIVERY_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

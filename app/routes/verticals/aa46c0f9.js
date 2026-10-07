const express = require('express');
const {
  purchasePolicy,
  COVERAGE_PACKAGES,
  BUNDLE_OFFERS,
  STATE_FACTORS,
} = require('../../services/verticals/aa46c0f9');

const router = express.Router();

router.get('/api/aa46c0f9/quote-options', (_req, res) => {
  res.json({
    packages: COVERAGE_PACKAGES,
    bundles: Object.entries(BUNDLE_OFFERS).map(([key, offer]) => ({
      key,
      label: offer.label,
      discountRate: offer.discountRate,
    })),
    states: Object.keys(STATE_FACTORS),
  });
});

router.post('/api/aa46c0f9/quote/purchase', async (req, res) => {
  try {
    const result = await purchasePolicy({
      zipCode: req.body.zipCode || '06183',
      state: req.body.state || 'CT',
      vehicles: req.body.vehicles || [{ year: 2024, make: 'Toyota', model: 'RAV4 XLE' }],
      drivers: req.body.drivers || [{ name: 'Primary driver', age: 42 }],
      coveragePackage: req.body.coveragePackage || 'standard',
      bundle: 'bundle' in req.body ? req.body.bundle : 'home',
      paymentPlan: req.body.paymentPlan || 'monthly',
      effectiveDate: req.body.effectiveDate,
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
      code: error.code || 'PURCHASE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

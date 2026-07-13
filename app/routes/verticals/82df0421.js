const express = require('express');
const { processQuote, VEHICLE_CLASSES, COVERAGE_PACKAGES } = require('../../services/verticals/82df0421');

const router = express.Router();

/**
 * GET /api/82df0421/products — returns available vehicle classes and coverage packages
 */
router.get('/api/82df0421/products', (_req, res) => {
  res.json({
    vehicles: Object.entries(VEHICLE_CLASSES).map(([id, v]) => ({ id, label: v.label })),
    coverage: COVERAGE_PACKAGES.map((c) => ({ id: c.id, label: c.label })),
  });
});

/**
 * POST /api/82df0421/quote — price an auto insurance quote
 */
router.post('/api/82df0421/quote', async (req, res) => {
  try {
    const result = await processQuote({
      vehicleType: req.body.vehicleType || 'sedan',
      state: req.body.state || 'VA',
      coverageId: req.body.coverageId || 'standard',
      driverAge: req.body.driverAge || 30,
      discounts: req.body.discounts || [],
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
      code: error.code || 'AUTO_QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

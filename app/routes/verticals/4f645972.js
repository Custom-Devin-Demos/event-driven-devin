const express = require('express');
const { processClaimEstimate, VEHICLES, INCIDENT_TYPES } = require('../../services/verticals/4f645972');

const router = express.Router();

/**
 * GET /api/4f645972/policy — returns policy vehicles and incident types
 * used to populate the claims form.
 */
router.get('/api/4f645972/policy', (_req, res) => {
  res.json({
    policyNumber: 'PGR-AUTO-4471902',
    holder: 'Jordan Ellis',
    vehicles: VEHICLES.map((v) => ({
      id: v.id,
      label: v.label,
      vin: v.vin,
      plate: v.plate,
    })),
    incidentTypes: INCIDENT_TYPES.map((t) => ({ id: t.id, label: t.label })),
  });
});

/**
 * POST /api/4f645972/estimate — file a claim and compute a repair estimate.
 */
router.post('/api/4f645972/estimate', async (req, res) => {
  try {
    const result = await processClaimEstimate({
      vehicleId: req.body.vehicleId || 'veh-1',
      incidentType: req.body.incidentType || 'collision',
      severity: req.body.severity || 'moderate',
      incidentDate: req.body.incidentDate,
      description: req.body.description,
      rentalDays: req.body.rentalDays || 0,
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
      code: error.code || 'CLAIM_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

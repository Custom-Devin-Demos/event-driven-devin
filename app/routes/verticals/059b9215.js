const express = require('express');
const { submitInspection, FACILITIES, INSPECTION_TYPES } = require('../../services/verticals/059b9215');

const router = express.Router();

/**
 * GET /api/059b9215/facilities — facilities under contract and inspection types
 */
router.get('/api/059b9215/facilities', (_req, res) => {
  const facilities = Object.entries(FACILITIES).map(([id, facility]) => ({ id, ...facility }));
  const inspectionTypes = Object.entries(INSPECTION_TYPES).map(([id, type]) => ({ id, ...type }));
  res.json({ facilities, inspectionTypes });
});

/**
 * POST /api/059b9215/inspection — submit an inspection result and generate the report
 */
router.post('/api/059b9215/inspection', async (req, res) => {
  try {
    const result = await submitInspection({
      facilityId: (req.body.facilityId || 'FAC-2041').trim(),
      inspectionType: (req.body.inspectionType || 'monthly').trim(),
      value: Number(req.body.value) || 0,
      inspectedOn: req.body.inspectedOn || '',
      notes: req.body.notes || '',
      photos: Array.isArray(req.body.photos) ? req.body.photos.map(String).slice(0, 20) : [],
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
      code: error.code || 'INSPECTION_SUBMIT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

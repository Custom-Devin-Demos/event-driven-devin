const express = require('express');
const { createWorkOrder, EQUIPMENT } = require('../../services/verticals/industrials');

const router = express.Router();

/**
 * GET /api/maintenance/equipment — returns equipment status
 */
router.get('/api/maintenance/equipment', (_req, res) => {
  res.json({ equipment: EQUIPMENT });
});

/**
 * POST /api/maintenance/workorder — create a maintenance work order
 */
router.post('/api/maintenance/workorder', async (req, res) => {
  try {
    const result = await createWorkOrder({
      equipmentId: req.body.equipmentId || 'EQ-001',
      equipmentCategory: req.body.equipmentCategory || 'Rotating',
      issueType: req.body.issueType || 'preventive',
      priority: req.body.priority || 'high',
      estimatedHours: req.body.estimatedHours || 4,
      partsEstimate: req.body.partsEstimate || 500,
      description: req.body.description || 'Scheduled maintenance',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'WORKORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

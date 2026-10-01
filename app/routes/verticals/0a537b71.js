const express = require('express');
const { submitInspection, REPAIR_ORDER, getInspectionItems } = require('../../services/verticals/0a537b71');

const router = express.Router();

router.get('/api/0a537b71/repair-order', (_req, res) => {
  res.json({ repairOrder: REPAIR_ORDER, items: getInspectionItems() });
});

router.post('/api/0a537b71/submit-mpi', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await submitInspection({
      repairOrderId: body.repairOrderId || REPAIR_ORDER.id,
      itemStatuses: body.itemStatuses,
      measurements: body.measurements,
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
      code: error.code || 'MPI_SUBMISSION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

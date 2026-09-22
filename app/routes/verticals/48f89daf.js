const express = require('express');
const { dispatchJob, JOBS, TECHNICIANS, TIME_SLOTS } = require('../../services/verticals/48f89daf');

const router = express.Router();

/**
 * GET /api/48f89daf/jobs — jobs, technicians and dispatch windows
 */
router.get('/api/48f89daf/jobs', (_req, res) => {
  res.json({ jobs: JOBS, technicians: TECHNICIANS, timeSlots: TIME_SLOTS });
});

/**
 * POST /api/48f89daf/dispatch — dispatch a pending job to a technician
 */
router.post('/api/48f89daf/dispatch', async (req, res) => {
  try {
    const confirmation = await dispatchJob({
      jobNo: req.body.jobNo,
      technicianId: req.body.technicianId,
      timeSlot: req.body.timeSlot,
      priority: req.body.priority,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DISPATCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

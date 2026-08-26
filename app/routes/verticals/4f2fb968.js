const express = require('express');
const { scheduleRepair, SERVICE_TYPES } = require('../../services/verticals/4f2fb968');

const router = express.Router();

/**
 * GET /api/4f2fb968/services — services bookable from Schedule A Repair
 */
router.get('/api/4f2fb968/services', (_req, res) => {
  res.json({
    services: SERVICE_TYPES.map((type) => ({
      code: type.code,
      name: type.name,
      description: type.description,
    })),
  });
});

/**
 * POST /api/4f2fb968/schedule-repair — submit a Schedule A Repair request
 */
router.post('/api/4f2fb968/schedule-repair', async (req, res) => {
  try {
    const result = await scheduleRepair({
      serviceCode: req.body.serviceCode || 'not-sure',
      technicianMessage: req.body.technicianMessage,
      vehicle: req.body.vehicle,
      firstChoiceStart: req.body.firstChoiceStart,
      secondChoiceStart: req.body.secondChoiceStart,
      waitPreference: req.body.waitPreference || 'drop-off',
      customerName: req.body.customerName,
      email: req.body.email,
      phone: req.body.phone,
      contactPreference: req.body.contactPreference,
      zip: req.body.zip,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SERVICE_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

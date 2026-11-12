const express = require('express');
const { SPECIALTIES, CAMPUSES, INSURERS, submitAppointmentRequest, confirmFollowUp } = require('../../services/verticals/8d8c2937');
const router = express.Router();

router.get('/api/8d8c2937/catalog', (_req, res) => res.json({
  specialties: SPECIALTIES, campuses: CAMPUSES, insurers: INSURERS,
}));

function sendError(req, res, error, fallbackCode) {
  res.status(error.status || 500).json({
    success: false, error: error.message, errorClass: error.name,
    code: error.code || fallbackCode, requestId: error.requestId || req.requestId,
  });
}

router.post('/api/8d8c2937/appointment-requests', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitAppointmentRequest({
      request: body.request,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    sendError(req, res, error, 'APPOINTMENT_REQUEST_FAILED');
  }
});

router.post('/api/8d8c2937/appointment-requests/:requestId/follow-up', (req, res) => {
  try {
    res.json(confirmFollowUp(req.params.requestId, (req.body || {}).windowId));
  } catch (error) {
    sendError(req, res, error, 'FOLLOW_UP_FAILED');
  }
});

module.exports = router;

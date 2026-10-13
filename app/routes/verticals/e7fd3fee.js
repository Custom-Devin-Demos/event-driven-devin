const express = require('express');
const path = require('path');
const { scheduleAppointment, ValidationError } = require('../../services/verticals/e7fd3fee');

const router = express.Router();

router.get('/e7fd3fee', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'e7fd3fee.html'));
});

router.post('/api/e7fd3fee/appointments', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await scheduleAppointment({
      topic: body.topic,
      channel: body.channel,
      centerId: body.centerId,
      date: body.date,
      time: body.time,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
        errorClass: 'ValidationError',
        code: 'INVALID_APPOINTMENT_REQUEST',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'APPOINTMENT_BOOKING_FAILED',
      referenceId: error.referenceId || req.requestId,
    });
  }
});

module.exports = router;

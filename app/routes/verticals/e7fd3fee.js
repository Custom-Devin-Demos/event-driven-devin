const express = require('express');
const path = require('path');
const { scheduleAppointment, ValidationError } = require('../../services/verticals/e7fd3fee');
const erica = require('../../services/verticals/e7fd3fee-erica');
const { createOlbRouter } = require('../../services/verticals/e7fd3fee-olb');

const router = express.Router();

router.use(createOlbRouter());

router.post('/api/e7fd3fee/erica/chat', (req, res) => {
  const body = req.body || {};
  try {
    res.json(erica.chat({
      text: typeof body.text === 'string' ? body.text.slice(0, 500) : '',
      action: body.action,
      locale: body.locale,
      sessionKey: req.get('X-CSRF-Token') || req.ip,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'ERICA_ACTION_FAILED',
        message: "Erica couldn't file your dispute. Nothing has changed.",
        errorClass: error.name,
        correlation_id: error.referenceId || req.requestId,
      },
      messages: error.ericaMessages,
    });
  }
});

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

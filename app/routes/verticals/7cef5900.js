const express = require('express');
const { bookAppointment, searchPractitioners, VISIT_MOTIVES } = require('../../services/verticals/7cef5900');

const router = express.Router();

router.get('/api/7cef5900/practitioners', (req, res) => {
  const practitioners = searchPractitioners();
  res.json({
    total: 7204,
    practitioners,
    motives: Object.entries(VISIT_MOTIVES).map(([key, label]) => ({ key, label })),
  });
});

router.post('/api/7cef5900/appointments', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await bookAppointment({
      practitionerId: body.practitionerId,
      date: body.date,
      time: body.time,
      motive: body.motive,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'BOOKING_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

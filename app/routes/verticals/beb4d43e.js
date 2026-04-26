const express = require('express');
const router = express.Router();
const { runInquiry, PROPERTIES, ROOM_CATALOG } = require('../../services/verticals/beb4d43e');

router.get('/api/beb4d43e/config', (_req, res) => {
  res.json({
    properties: Object.entries(PROPERTIES).map(([code, p]) => ({ code, name: p.name })),
    roomTypes: Object.keys(ROOM_CATALOG),
  });
});

router.post('/api/beb4d43e/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      property: req.body.property || 'maui',
      roomType: req.body.roomType || 'suite',
      nights: req.body.nights || 3,
      guests: req.body.guests || 2,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'PROPERTY_NOT_FOUND' || error.code === 'INVALID_ROOM_TYPE' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

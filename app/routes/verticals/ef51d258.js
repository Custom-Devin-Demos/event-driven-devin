const express = require('express');
const {
  searchAvailability,
  DESTINATIONS,
  RATE_PREFERENCES,
} = require('../../services/verticals/ef51d258');

const router = express.Router();

router.get('/api/ef51d258/destinations', (req, res) => {
  res.json({
    destinations: Object.entries(DESTINATIONS).map(([key, d]) => ({
      key,
      label: d.label,
      hotelCount: d.hotels.length,
    })),
    ratePreferences: Object.entries(RATE_PREFERENCES).map(([key, r]) => ({
      key,
      label: r.label,
    })),
  });
});

router.post('/api/ef51d258/availability', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchAvailability({
      destination: body.destination,
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      rooms: body.rooms,
      adults: body.adults,
      ratePreference: body.ratePreference,
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
      code: error.code || 'AVAILABILITY_SEARCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

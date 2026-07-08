const express = require('express');
const { processReservation, EVENTS, VENUES } = require('../../services/verticals/efbf4b55');

const router = express.Router();

/**
 * GET /api/efbf4b55/events — returns the event catalog
 */
router.get('/api/efbf4b55/events', (_req, res) => {
  res.json({
    events: EVENTS.map((e) => {
      const venue = VENUES.find((v) => v.id === e.venueId);
      return {
        id: e.id,
        title: e.title,
        category: e.category,
        venue: venue ? venue.name : e.venueId,
        district: venue ? venue.district : '',
        date: e.date,
        time: e.time,
        basePrice: e.basePrice,
      };
    }),
  });
});

/**
 * POST /api/efbf4b55/reserve — reserve seats for an event
 */
router.post('/api/efbf4b55/reserve', async (req, res) => {
  try {
    const result = await processReservation({
      eventId: req.body.eventId || 'evt-2104',
      tier: req.body.tier || 'balcon',
      quantity: req.body.quantity || 2,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESERVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

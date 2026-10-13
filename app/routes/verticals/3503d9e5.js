const express = require('express');
const { processBooking, getFlightSearch, DEFAULT_BOOKING } = require('../../services/verticals/3503d9e5');

const router = express.Router();

/**
 * GET /api/3503d9e5/flights — flight search results (FSR) for the demo market
 */
router.get('/api/3503d9e5/flights', (_req, res) => {
  res.json(getFlightSearch());
});

/**
 * POST /api/3503d9e5/bookings — purchase and ticket the selected itinerary
 */
router.post('/api/3503d9e5/bookings', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await processBooking({
      outbound: body.outbound || DEFAULT_BOOKING.outbound,
      inbound: body.inbound || DEFAULT_BOOKING.inbound,
      cabin: body.cabin || DEFAULT_BOOKING.cabin,
      fareBrand: body.fareBrand || DEFAULT_BOOKING.fareBrand,
      basicEconomyAck: body.basicEconomyAck === true,
      traveler: body.traveler || { firstName: 'Jordan', lastName: 'Lee' },
      payment: body.payment || { brand: 'Visa', cardLast4: '1111' },
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
      code: error.statusCode === 400 ? 'BOOKING_VALIDATION_FAILED' : 'BOOKING_PURCHASE_FAILED',
      bookingId: error.bookingId,
      requestId: req.requestId,
    });
  }
});

module.exports = router;

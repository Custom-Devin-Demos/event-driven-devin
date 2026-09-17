const express = require('express');
const { processFlightSearch, ROUTES, AIRPORTS, FARE_PRODUCTS } = require('../../services/verticals/681c416f');

const router = express.Router();

router.get('/api/681c416f/routes', (_req, res) => {
  res.json({
    airports: AIRPORTS,
    fareProducts: Object.entries(FARE_PRODUCTS).map(([id, p]) => ({ id, code: p.code, label: p.label })),
    routes: ROUTES.map((r) => ({
      origin: r.origin,
      destination: r.destination,
      flightNumber: r.flightNumber,
      departs: r.departs,
      arrives: r.arrives,
    })),
  });
});

router.post('/api/681c416f/search-flights', async (req, res) => {
  try {
    const result = await processFlightSearch({
      origin: req.body.origin || 'OAK',
      destination: req.body.destination || 'LAS',
      departureDate: req.body.departureDate,
      returnDate: req.body.returnDate,
      tripType: req.body.tripType || 'round-trip',
      fareProduct: req.body.fareProduct || 'basic',
      passengers: req.body.passengers || 1,
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
      code: error.code || 'FLIGHT_SEARCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

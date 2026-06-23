const express = require('express');
const { processFlightSearch, ROUTES } = require('../../services/verticals/4ada28b9');

const router = express.Router();

/**
 * GET /api/4ada28b9/routes — returns available flight routes
 */
router.get('/api/4ada28b9/routes', (_req, res) => {
  res.json({
    routes: ROUTES.map((r) => ({
      origin: r.origin,
      destination: r.destination,
      flightNumber: r.flightNumber,
      aircraft: r.aircraft,
    })),
  });
});

/**
 * POST /api/4ada28b9/search-flights — search and price flights
 */
router.post('/api/4ada28b9/search-flights', async (req, res) => {
  try {
    const result = await processFlightSearch({
      origin: req.body.origin || 'EWR',
      destination: req.body.destination || 'LAX',
      cabin: req.body.cabin || 'economy',
      passengers: req.body.passengers || 1,
      ancillaries: req.body.ancillaries || [],
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

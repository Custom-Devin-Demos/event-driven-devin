const express = require('express');
const { processFlightQuote, ROUTES } = require('../../services/verticals/e370cc3c');

const router = express.Router();

/**
 * GET /api/e370cc3c/routes — returns the bookable nonstop routes
 */
router.get('/api/e370cc3c/routes', (_req, res) => {
  res.json({
    routes: ROUTES.map((r) => ({
      id: r.id,
      origin: r.origin,
      destination: r.destination,
      aircraft: r.aircraft,
    })),
  });
});

/**
 * POST /api/e370cc3c/flight-quote — build a flight quote for the search widget
 */
router.post('/api/e370cc3c/flight-quote', async (req, res) => {
  try {
    const result = await processFlightQuote({
      origin: req.body.origin || 'SFO',
      destination: req.body.destination || 'JFK',
      fareProduct: req.body.fareProduct || 'comfort_plus',
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
      code: error.code || 'FLIGHT_QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

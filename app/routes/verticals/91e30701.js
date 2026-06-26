const express = require('express');
const { processQuoteRequest, EDITIONS } = require('../../services/verticals/91e30701');

const router = express.Router();

/**
 * GET /api/91e30701/editions — returns available product editions
 */
router.get('/api/91e30701/editions', (_req, res) => {
  res.json({
    editions: Object.entries(EDITIONS).map(([id, e]) => ({
      id,
      code: e.code,
      name: e.name,
      seatPrice: e.seatPrice,
      supportLevel: e.supportLevel,
    })),
  });
});

/**
 * POST /api/91e30701/quote — build an IT solution quote
 */
router.post('/api/91e30701/quote', async (req, res) => {
  try {
    const result = await processQuoteRequest({
      edition: req.body.edition || 'starter',
      seats: req.body.seats || 10,
      modules: req.body.modules || [],
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
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

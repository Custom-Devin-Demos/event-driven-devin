const express = require('express');

const router = express.Router();
const { getStyleRecommendations, ROOM_PRODUCTS, STYLE_PROFILES } = require('../../services/verticals/wayfair');

/**
 * GET /api/wayfair/catalog — return product catalog and style options
 */
router.get('/api/wayfair/catalog', (_req, res) => {
  res.json({
    products: ROOM_PRODUCTS,
    styles: Object.keys(STYLE_PROFILES),
    rooms: ['living-room', 'bedroom', 'dining-room', 'home-office'],
  });
});

/**
 * POST /api/wayfair/recommendations — get personalized style recommendations
 */
router.post('/api/wayfair/recommendations', async (req, res) => {
  try {
    const result = await getStyleRecommendations({
      room: req.body.room || 'living-room',
      style: req.body.style || 'modern',
      budget: req.body.budget || 1000,
      userId: req.body.userId || 'usr_wayfair_1',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RECOMMENDATION_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

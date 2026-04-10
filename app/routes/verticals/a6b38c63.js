const express = require('express');

const router = express.Router();
const { getStyleRecommendations, ROOM_PRODUCTS, STYLE_PROFILES } = require('../../services/verticals/a6b38c63');

/**
 * GET /api/a6b38c63/catalog — return product catalog and style options
 */
router.get('/api/a6b38c63/catalog', (_req, res) => {
  res.json({
    products: ROOM_PRODUCTS,
    styles: Object.keys(STYLE_PROFILES),
    rooms: ['living-room', 'bedroom', 'dining-room', 'home-office'],
  });
});

/**
 * POST /api/a6b38c63/recommendations — get personalized style recommendations
 */
router.post('/api/a6b38c63/recommendations', async (req, res) => {
  try {
    const result = await getStyleRecommendations({
      room: req.body.room || 'living-room',
      style: req.body.style || 'modern',
      budget: req.body.budget || 1000,
      userId: req.body.userId || 'usr_wayfair_1',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
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

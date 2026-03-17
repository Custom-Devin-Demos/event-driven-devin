const express = require('express');
const { processLogin, CARDMEMBERS, CARD_PRODUCTS } = require('../../services/verticals/barclays-cards');

const router = express.Router();

/**
 * GET /api/barclays-cards/products — returns card products and cardmember list
 */
router.get('/api/barclays-cards/products', (_req, res) => {
  res.json({ cardProducts: CARD_PRODUCTS, cardmembers: CARDMEMBERS });
});

/**
 * POST /api/barclays-cards/login — process a cardmember login
 */
router.post('/api/barclays-cards/login', async (req, res) => {
  try {
    const result = await processLogin({
      username: req.body.username || 'jdoe_barclays',
      password: req.body.password || '',
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'RATE_LIMITED' ? 429 : error.code === 'AUTH_FAILED' ? 401 : 500;
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

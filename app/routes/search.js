const express = require('express');
const { searchProducts } = require('../services/search');

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const { q, persona } = req.query;
    const result = await searchProducts(q || '', persona || 'buyer_1');
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;

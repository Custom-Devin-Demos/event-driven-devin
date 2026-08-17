const express = require('express');
const router = express.Router();
const { getCart, processOrder } = require('../../services/verticals/79147793');

router.get('/api/79147793/cart', (_req, res) => {
  res.json(getCart());
});

router.post('/api/79147793/order', async (req, res) => {
  try {
    const result = await processOrder(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
    });
  }
});

module.exports = router;

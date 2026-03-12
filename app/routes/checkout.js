const express = require('express');
const { processCheckout } = require('../services/checkout');

const router = express.Router();

router.post('/checkout', async (req, res) => {
  try {
    const result = await processCheckout(req.body);
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'PAYMENT_TIMEOUT' ? 504
      : error.code === 'INVENTORY_CONFLICT' ? 409
      : 500;

    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
    });
  }
});

module.exports = router;

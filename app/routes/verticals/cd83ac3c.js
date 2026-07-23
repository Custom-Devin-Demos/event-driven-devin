const express = require('express');
const path = require('path');
const { processCheckout, PRODUCTS } = require('../../services/verticals/cd83ac3c');

const router = express.Router();

router.get('/cd83ac3c', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'cd83ac3c.html'));
});

router.get('/api/cd83ac3c/products', (_req, res) => {
  res.json({
    products: PRODUCTS.map((product) => ({
      sku: product.sku,
      name: product.name,
      price: product.price,
      category: product.category,
    })),
  });
});

router.post('/api/cd83ac3c/checkout', async (req, res) => {
  try {
    const result = await processCheckout(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'EMPTY_CART' ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

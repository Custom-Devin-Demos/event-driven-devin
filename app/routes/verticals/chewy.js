const express = require('express');
const path = require('path');
const { processCheckout, PRODUCTS } = require('../../services/verticals/chewy');

const router = express.Router();

router.get('/chewy', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'chewy.html'));
});

router.get('/api/chewy/products', (_req, res) => {
  res.json({
    products: PRODUCTS.map((product) => ({
      id: product.id,
      brand: product.brand,
      name: product.name,
      listPrice: product.listPrice,
      price: product.price,
      category: product.category,
    })),
  });
});

router.post('/api/chewy/checkout', async (req, res) => {
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

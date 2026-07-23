const express = require('express');
const path = require('path');
const { processCheckout, PRODUCTS } = require('../../services/verticals/coppel');

const router = express.Router();

router.get('/coppel', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'coppel.html'));
});

router.get('/api/coppel/products', (_req, res) => {
  res.json({
    products: PRODUCTS.map((product) => ({
      id: product.id,
      name: product.name,
      listPrice: product.listPrice,
      price: product.price,
      seller: product.seller,
      category: product.category,
    })),
  });
});

router.post('/api/coppel/checkout', async (req, res) => {
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

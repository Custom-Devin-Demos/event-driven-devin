const express = require('express');
const path = require('path');
const { processOrder, MENU, STORES } = require('../../services/verticals/tacobell');

const router = express.Router();

router.get('/tacobell', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'tacobell.html'));
});

router.get('/api/tacobell/menu', (_req, res) => {
  res.json({
    menu: MENU.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
    })),
    stores: STORES.map((store) => ({
      id: store.id,
      name: store.name,
      address: store.address,
    })),
  });
});

router.post('/api/tacobell/order', async (req, res) => {
  try {
    const result = await processOrder(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'EMPTY_BAG' || error.code === 'STORE_NOT_FOUND' ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { getOrder, listOrders } = require('../services/orders');

const router = express.Router();

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await getOrder(req.params.id, req.query.persona);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: `Order ${req.params.id} not found`,
      });
    }
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const orders = await listOrders(req.query.userId);
    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;

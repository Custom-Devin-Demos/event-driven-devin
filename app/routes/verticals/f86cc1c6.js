const express = require('express');
const { getMenu, submitMobileOrder } = require('../../services/verticals/f86cc1c6');

const router = express.Router();

router.get('/api/f86cc1c6/menu', (req, res) => {
  res.json(getMenu(req.query.restaurantId));
});

router.post('/api/f86cc1c6/mobile-order', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitMobileOrder({
      restaurantId: body.restaurantId,
      items: body.items,
      arrivalWindow: body.arrivalWindow,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'MOBILE_ORDER_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

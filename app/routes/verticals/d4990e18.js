const express = require('express');
const {
  processSearch,
  RESTAURANTS,
  MENU_ITEMS,
} = require('../../services/verticals/d4990e18');
const { DELIVERY_PROFILES } = require('../../services/verticals/d4990e18-fulfillment');

const router = express.Router();

router.get('/api/d4990e18/catalog', (_req, res) => {
  res.json({
    restaurants: RESTAURANTS,
    menuItems: MENU_ITEMS,
    deliveryProfiles: Object.values(DELIVERY_PROFILES),
  });
});

router.post('/api/d4990e18/search', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};

  try {
    const result = await processSearch({
      address: body.address,
      deliveryWindow: body.deliveryWindow,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      errorClass: error.name || 'Error',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

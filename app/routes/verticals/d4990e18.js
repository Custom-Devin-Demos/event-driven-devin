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
  try {
    const result = await processSearch({
      address: req.body.address,
      deliveryWindow: req.body.deliveryWindow,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      errorClass: error.name || 'Error',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { processCateringOrder, CATERING_MENU, LOCATIONS } = require('../../services/verticals/b3587482');

router.get('/api/b3587482/menu', (_req, res) => {
  res.json({
    menu: CATERING_MENU.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      servings: item.servings,
    })),
    locations: LOCATIONS.map((loc) => ({
      id: loc.id,
      name: loc.name,
      address: loc.address,
    })),
  });
});

router.post('/api/b3587482/order', async (req, res) => {
  try {
    const result = await processCateringOrder(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'EMPTY_ORDER' || error.code === 'LOCATION_NOT_FOUND' ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
    });
  }
});

module.exports = router;

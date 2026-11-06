const express = require('express');
const { CATALOG, CRUST_SIZES, addToCart } = require('../../services/verticals/4ff94526');
const router = express.Router();

router.get('/api/4ff94526/catalog', (_req, res) => res.json({ groups: CATALOG, crustSizes: CRUST_SIZES }));

router.post('/api/4ff94526/cart', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await addToCart({
      pizza: body.pizza,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'PIZZA_CART_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;

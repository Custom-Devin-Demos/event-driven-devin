const express = require('express');
const { addToCart } = require('../../services/verticals/8d3527ab');

const router = express.Router();

router.post('/api/8d3527ab/cart', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await addToCart({
      username: body.username || 'dealer@demo.cummins',
      sku: body.sku,
      quantity: body.quantity,
      subscriptionTerm: body.subscriptionTerm,
      esn: body.esn,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_CART_ITEM',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'Cart_Error_Unknown',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

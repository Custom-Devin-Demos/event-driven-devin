const express = require('express');
const { placeOrder, ROUTE } = require('../../services/verticals/0875ddd9');

const router = express.Router();

router.post(ROUTE, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await placeOrder({
      title: body.title || 'nba-2k27',
      edition: body.edition || 'standard',
      platform: body.platform || 'ps5',
      email: body.email,
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
      code: error.code || 'CHECKOUT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

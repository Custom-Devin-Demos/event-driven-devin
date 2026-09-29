const express = require('express');
const {
  previewOrder,
  SYMBOLS,
  ROUTING_OPTIONS,
} = require('../../services/verticals/d708940c');

const router = express.Router();

router.get('/api/d708940c/instruments', (req, res) => {
  res.json({
    symbols: Object.entries(SYMBOLS).map(([key, symbol]) => ({
      key,
      label: symbol.label,
      exchange: symbol.exchange,
    })),
    routingOptions: Object.entries(ROUTING_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      venueCount: option.venues.length,
    })),
  });
});

router.post('/api/d708940c/order-preview', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await previewOrder({
      symbol: body.symbol,
      side: body.side,
      quantity: body.quantity,
      orderType: body.orderType,
      limitPrice: body.limitPrice,
      routing: body.routing,
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
      code: error.code || 'ORDER_PREVIEW_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

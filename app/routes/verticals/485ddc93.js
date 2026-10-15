const express = require('express');
const { buildStorefront, placeOrder } = require('../../services/verticals/485ddc93');

const router = express.Router();

router.get('/api/485ddc93/storefront', (_req, res) => {
  res.json(buildStorefront());
});

router.post('/api/485ddc93/orders', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await placeOrder({
      product: body.product,
      size: body.size,
      destination: body.destination,
      cardMessage: body.cardMessage,
      cardSignature: body.cardSignature,
      senderName: body.senderName,
      senderEmail: body.senderEmail,
      recipientName: body.recipientName,
      recipientAddress: body.recipientAddress,
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
      code: error.code || 'ORDER_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

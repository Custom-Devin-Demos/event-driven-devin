const express = require('express');
const { placeOrder, getStorefront } = require('../../services/verticals/f2f40117');

const router = express.Router();

router.get('/api/f2f40117/storefront', (_req, res) => {
  res.json(getStorefront());
});

router.post('/api/f2f40117/orders', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const order = await placeOrder({
      eventId: valueOrDefault('eventId', 'FB26-RIV'),
      sectionId: valueOrDefault('sectionId', '108'),
      priceType: valueOrDefault('priceType', 'adult'),
      quantity: valueOrDefault('quantity', 2),
      quantities: body.quantities,
      deliveryMethod: valueOrDefault('deliveryMethod', 'mobile'),
      donationAmount: valueOrDefault('donationAmount', 100),
      accountId: valueOrDefault('accountId', 'CPS-4471028'),
      paymentMethodId: valueOrDefault('paymentMethodId', 'pm_visa_4421'),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(order);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_ORDER',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_PROCESSING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

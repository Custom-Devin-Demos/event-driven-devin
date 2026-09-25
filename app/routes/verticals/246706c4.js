const path = require('path');
const express = require('express');
const { confirmBooking, BOOKINGS, PRICE_BOOK } = require('../../services/verticals/246706c4');

const router = express.Router();

const PAY_PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', '246706c4-pay.html');

router.get('/246706c4/pay', (_req, res) => {
  res.sendFile(PAY_PAGE);
});

router.get('/api/246706c4/booking/:bookingId', (req, res) => {
  const booking = BOOKINGS.find((b) => b.bookingId === req.params.bookingId);
  if (!booking) {
    return res.status(404).json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' });
  }
  return res.json({ booking, priceBook: PRICE_BOOK });
});

router.post('/api/246706c4/payment', async (req, res) => {
  const body = req.body || {};
  if (!body.bookingId || !body.paymentMethod) {
    return res.status(400).json({ success: false, error: 'bookingId and paymentMethod are required', code: 'VALIDATION_ERROR' });
  }
  if (!BOOKINGS.find((b) => b.bookingId === body.bookingId)) {
    return res.status(404).json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' });
  }
  if (!['card', 'apple_pay', 'google_pay'].includes(body.paymentMethod)) {
    return res.status(400).json({ success: false, error: `Unknown payment method: ${body.paymentMethod}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await confirmBooking({
      bookingId: body.bookingId,
      paymentMethod: body.paymentMethod,
      card: body.card || {},
      customer: body.customer,
      marketing: body.marketing,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
      requestId: req.requestId,
    });
  }
});

module.exports = router;

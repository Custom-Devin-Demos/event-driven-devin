const path = require('path');
const express = require('express');
const { getAvailability, createHold, checkout } = require('../../services/verticals/90ccfbb2');
const { getDiningAvailability, createReservation } = require('../../services/verticals/90ccfbb2-dining');

const router = express.Router();
const PAGES_DIR = path.join(__dirname, '..', '..', 'public', 'verticals');

router.get('/90ccfbb2/tickets', (_req, res) => res.sendFile(path.join(PAGES_DIR, '90ccfbb2.html')));
router.get('/90ccfbb2/dining', (_req, res) => res.sendFile(path.join(PAGES_DIR, '90ccfbb2', 'dining.html')));

function sendError(res, req, error) {
  res.status(error.statusCode || 500).json({
    success: false,
    code: error.code || 'INVENTORY_ERROR',
    error: error.message,
    requestId: req.requestId,
    ...(error.reference ? { reference: error.reference, detail: error.detail } : {}),
  });
}

router.post('/api/90ccfbb2/availability', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await getAvailability({
      productId: body.productId,
      from: body.from,
      days: body.days,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    sendError(res, req, error);
  }
});

router.post('/api/90ccfbb2/holds', async (req, res) => {
  const body = req.body || {};
  try {
    res.status(201).json(await createHold({ productId: body.productId, date: body.date, quantity: body.quantity, devinEmail: body.devinEmail }));
  } catch (error) {
    sendError(res, req, error);
  }
});

router.post('/api/90ccfbb2/checkout', async (req, res) => {
  try {
    res.json(await checkout({ holdId: (req.body || {}).holdId }));
  } catch (error) {
    sendError(res, req, error);
  }
});

router.post('/api/90ccfbb2/dining/availability', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await getDiningAvailability({ restaurantId: body.restaurantId, date: body.date }));
  } catch (error) {
    sendError(res, req, error);
  }
});

router.post('/api/90ccfbb2/dining/reservations', async (req, res) => {
  const body = req.body || {};
  try {
    res.status(201).json(await createReservation({
      restaurantId: body.restaurantId,
      date: body.date,
      time: body.time,
      partySize: body.partySize,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    sendError(res, req, error);
  }
});

module.exports = router;

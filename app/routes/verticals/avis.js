const express = require('express');
const { processReservation, CATALOG } = require('../../services/verticals/avis');

const router = express.Router();

router.get('/api/avis/catalog', (_req, res) => {
  res.json({ vehicles: CATALOG });
});

router.post('/api/avis/reservation', async (req, res) => {
  try {
    const result = await processReservation({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'AVIS-MID', qty: 3, price: 55.00 }],
      subtotal: req.body.subtotal || 165.00,
      location: req.body.location || 'LAX',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESERVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

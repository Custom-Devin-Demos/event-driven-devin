const express = require('express');
const { processBooking, CATALOG } = require('../../services/verticals/bnsf');

const router = express.Router();

router.get('/api/bnsf/catalog', (_req, res) => {
  res.json({ equipment: CATALOG });
});

router.post('/api/bnsf/booking', async (req, res) => {
  try {
    const result = await processBooking({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'BNSF-INT-53HC', qty: 1, price: 2850.00 }],
      subtotal: req.body.subtotal || 2850.00,
      lane: req.body.lane || 'TRANSCON',
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
      code: error.code || 'BOOKING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

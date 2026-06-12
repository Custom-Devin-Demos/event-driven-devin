const express = require('express');
const { processPrescriptionOrder, CATALOG } = require('../../services/verticals/optumrx');

const router = express.Router();

router.get('/api/optumrx/catalog', (_req, res) => {
  res.json({ medications: CATALOG });
});

router.post('/api/optumrx/order', async (req, res) => {
  try {
    const result = await processPrescriptionOrder({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'RX-ATOR-20', qty: 1, price: 14.00 }],
      subtotal: req.body.subtotal || 14.00,
      plan: req.body.plan || 'STANDARD',
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

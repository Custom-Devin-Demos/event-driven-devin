const express = require('express');
const { processPurchase, CATALOG } = require('../../services/verticals/bc6a7c34');

const router = express.Router();

router.get('/api/bc6a7c34/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/bc6a7c34/purchase', async (req, res) => {
  try {
    const result = await processPurchase({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'EA-MADDEN27-DLX', qty: 1, price: 99.99 }],
      subtotal: req.body.subtotal || 99.99,
      region: req.body.region || 'US',
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
      code: error.code || 'PURCHASE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

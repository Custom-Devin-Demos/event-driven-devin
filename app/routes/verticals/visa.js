const express = require('express');
const { processAuthorization, CATALOG } = require('../../services/verticals/visa');

const router = express.Router();

router.get('/api/visa/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/visa/authorize', async (req, res) => {
  try {
    const result = await processAuthorization({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'TKT-WC26-FINAL', qty: 1, price: 950.00 }],
      amount: req.body.amount || 950.00,
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
      code: error.code || 'AUTHORIZATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

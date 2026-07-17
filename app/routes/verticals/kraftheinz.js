const express = require('express');
const path = require('path');
const { processOrder, CATALOG } = require('../../services/verticals/kraftheinz');

const router = express.Router();

router.get('/kraftheinz', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'kraftheinz.html'));
});

router.get('/api/kraftheinz/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/kraftheinz/order', async (req, res) => {
  try {
    const result = await processOrder({
      distributorId: req.body.distributorId || 'DIST-KH-001',
      region: req.body.region || 'northeast',
      fulfillmentZone: req.body.fulfillmentZone || 'southeast',
      items: req.body.items || [{ sku: 'BEV-001', qty: 50 }],
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

const express = require('express');
const { processReplenishment, DISTRIBUTION_NETWORK } = require('../../services/verticals/058bcc4c');

const router = express.Router();

router.get('/api/058bcc4c/network', (_req, res) => {
  res.json(DISTRIBUTION_NETWORK);
});

router.post('/api/058bcc4c/replenishment', async (req, res) => {
  try {
    const result = await processReplenishment({
      originPlant: req.body.originPlant || 'PLT-FREMONT-OH',
      destinationDc: req.body.destinationDc || 'DC-MASON',
      sku: req.body.sku || 'HEINZ-KETCHUP-32OZ',
      quantity: req.body.quantity || 480,
      devinUserId: req.body.devinUserId || '',
      devinOrgId: req.body.devinOrgId || '',
      devinEmail: req.body.devinEmail || '',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'REPLENISHMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

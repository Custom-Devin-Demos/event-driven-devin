const express = require('express');
const path = require('path');
const { authorizePayment, MERCHANTS } = require('../../services/verticals/2ef89b23');

const router = express.Router();

router.get('/2ef89b23', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '2ef89b23.html'));
});

router.get('/api/2ef89b23/merchants', (_req, res) => {
  res.json({ merchants: MERCHANTS });
});

router.post('/api/2ef89b23/authorize', async (req, res) => {
  try {
    const result = await authorizePayment({
      merchantId: req.body.merchantId || 'MID-4471902',
      amount: req.body.amount || 248.5,
      cardBin: req.body.cardBin || '431940',
      issuerCountry: req.body.issuerCountry || 'US',
      riskScore: req.body.riskScore || 12,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const clientErrors = ['INVALID_NETWORK', 'INVALID_CHANNEL'];
    res.status(clientErrors.includes(error.code) ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'AUTHORIZATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

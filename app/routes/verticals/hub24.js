const express = require('express');
const path = require('path');
const {
  submitFeeArrangement,
  CLIENT_ACCOUNTS,
  FREQUENCY_OPTIONS,
} = require('../../services/verticals/hub24');

const router = express.Router();

router.get('/hub24', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'hub24.html'));
});

router.get('/api/hub24/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(CLIENT_ACCOUNTS).map((account) => ({
      clientAccountId: account.clientAccountId,
      clientName: account.clientName,
      productLabel: account.productLabel,
      portfolioValue: account.portfolioValue,
      adviser: account.adviser,
      afsl: account.afsl,
    })),
    frequencyOptions: FREQUENCY_OPTIONS,
  });
});

router.post('/api/hub24/fee-arrangement', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const arrangement = await submitFeeArrangement({
      clientAccountId: valueOrDefault('clientAccountId', 'HUB24-8842167'),
      feeBasis: valueOrDefault('feeBasis', 'percentage'),
      feeAmount: valueOrDefault('feeAmount', 0.95),
      frequency: valueOrDefault('frequency', 'monthly'),
      startDate: valueOrDefault('startDate', '2026-09-14'),
      clientConsent: valueOrDefault('clientConsent', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(arrangement);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_FEE_ARRANGEMENT',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'FEE_ARRANGEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

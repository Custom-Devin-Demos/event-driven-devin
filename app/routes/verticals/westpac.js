const express = require('express');
const path = require('path');
const {
  submitDispute,
  CARDS,
} = require('../../services/verticals/westpac');

const router = express.Router();

router.get('/westpac', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'westpac.html'));
});

router.get('/api/westpac/cards', (_req, res) => {
  res.json({
    cards: Object.values(CARDS),
  });
});

router.post('/api/westpac/dispute', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const dispute = await submitDispute({
      cardAccountNumber: valueOrDefault('cardAccountNumber', 'WBC-CC-4417-2280'),
      disputeReason: valueOrDefault('disputeReason', 'unauthorised'),
      merchantName: valueOrDefault('merchantName', 'LUMA TRAVEL SERVICES PTY LTD'),
      transactionDate: valueOrDefault('transactionDate', '2026-09-18'),
      transactionAmount: valueOrDefault('transactionAmount', 2480.75),
      cardPresent: valueOrDefault('cardPresent', false),
      contactedMerchant: valueOrDefault('contactedMerchant', true),
      cardLostOrStolen: valueOrDefault('cardLostOrStolen', false),
      contactNumber: valueOrDefault('contactNumber', '0438 662 105'),
      description: valueOrDefault(
        'description',
        'I did not authorise this charge. I have never used this merchant and my card has not left my wallet. I contacted the merchant on 20 September and they could not locate any booking in my name.',
      ),
      declaration: valueOrDefault('declaration', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(dispute);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_DISPUTE_REQUEST',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DISPUTE_LODGEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

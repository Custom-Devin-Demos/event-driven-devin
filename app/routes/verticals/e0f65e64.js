const express = require('express');
const path = require('path');
const { notifyPayment, ACCOUNTS, PAYMENT_METHODS } = require('../../services/verticals/e0f65e64');

const router = express.Router();

router.get('/e0f65e64', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'e0f65e64.html'));
});

router.get('/api/e0f65e64/account', (_req, res) => {
  const account = ACCOUNTS['512 483 771'];
  res.json({
    account,
    paymentMethods: Object.entries(PAYMENT_METHODS).map(([code, method]) => ({
      code,
      label: method.label,
    })),
  });
});

router.post('/api/e0f65e64/payment-notification', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const confirmation = await notifyPayment({
      accountNumber: valueOrDefault('accountNumber', '512 483 771'),
      paymentMethod: valueOrDefault('paymentMethod', 'interac_etransfer'),
      amount: valueOrDefault('amount', 186.42),
      paymentDate: valueOrDefault('paymentDate', new Date().toISOString().slice(0, 10)),
      referenceNumber: body.referenceNumber,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PAYMENT_NOTIFICATION',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PAYMENT_NOTIFICATION_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

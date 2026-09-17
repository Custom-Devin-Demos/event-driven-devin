const express = require('express');
const path = require('path');
const { submitPayment, ACCOUNTS } = require('../../services/verticals/cba');

const router = express.Router();

router.get('/cba', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'cba.html'));
});

router.get('/api/cba/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(ACCOUNTS).map((account) => ({
      accountNumber: account.accountNumber,
      productLabel: account.productLabel,
      holderName: account.holderName,
      balance: account.balance,
      dailyLimit: account.dailyLimit,
    })),
  });
});

router.post('/api/cba/payment', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const payment = await submitPayment({
      fromAccount: valueOrDefault('fromAccount', '062-000 10345678'),
      paymentMethod: valueOrDefault('paymentMethod', 'payid'),
      payeeName: valueOrDefault('payeeName', 'Sunrise Plumbing Pty Ltd'),
      payeeBsb: body.payeeBsb,
      payeeAccount: body.payeeAccount,
      payId: valueOrDefault('payId', '54 692 411 003'),
      payIdType: valueOrDefault('payIdType', 'abn'),
      billerCode: body.billerCode,
      billerReference: body.billerReference,
      amount: valueOrDefault('amount', 1480),
      description: valueOrDefault('description', 'Invoice 80114'),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(payment);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PAYMENT',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PAYMENT_SETTLEMENT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

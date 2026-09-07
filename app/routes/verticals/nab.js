const express = require('express');
const path = require('path');
const { submitPayment, ACCOUNTS } = require('../../services/verticals/nab');

const router = express.Router();

router.get('/nab', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'nab.html'));
});

router.get('/api/nab/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(ACCOUNTS).map((account) => ({
      accountNumber: account.accountNumber,
      productLabel: account.productLabel,
      holderName: account.holderName,
      balance: account.balance,
    })),
  });
});

router.post('/api/nab/payment', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const payment = await submitPayment({
      fromAccount: valueOrDefault('fromAccount', '082-001 40817266'),
      paymentMethod: valueOrDefault('paymentMethod', 'pay_anyone'),
      payeeName: valueOrDefault('payeeName', 'Harper Electrical Services'),
      payeeBsb: valueOrDefault('payeeBsb', '083-004'),
      payeeAccount: valueOrDefault('payeeAccount', '55910238'),
      amount: valueOrDefault('amount', 1250),
      description: valueOrDefault('description', 'Invoice 2261'),
      payId: body.payId,
      billerCode: body.billerCode,
      billerReference: body.billerReference,
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

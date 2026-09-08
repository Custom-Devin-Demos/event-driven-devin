const express = require('express');
const path = require('path');
const { submitPayment, ACCOUNTS, PAYEES } = require('../../services/verticals/suncorp');

const router = express.Router();

router.get('/suncorp', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'suncorp.html'));
});

router.get('/api/suncorp/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(ACCOUNTS).map((account) => ({
      accountId: account.accountId,
      name: account.accountName,
      accountName: account.accountName,
      bsb: account.bsb,
      accountNumber: account.accountNumber,
      maskedAccountNumber: `${account.bsb} ****${account.accountNumber.slice(-4)}`,
      productLabel: account.productLabel,
      availableBalance: account.availableBalance,
    })),
    payees: Object.values(PAYEES).map((payee) => ({
      payeeId: payee.payeeId,
      name: payee.name,
      nickname: payee.nickname,
      bsb: payee.bsb,
      accountNumber: payee.accountNumber,
      payId: payee.payId,
    })),
  });
});

router.post('/api/suncorp/payment', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  const paymentData = {
    fromAccountId: valueOrDefault('fromAccountId', '502113847'),
    payeeId: valueOrDefault('payeeId', 'PAY-1001'),
    amount: valueOrDefault('amount', 850),
    description: valueOrDefault('description', 'Rent — September'),
    paymentDate: valueOrDefault('paymentDate', '2026-09-08'),
    payMethod: valueOrDefault('payMethod', 'osko'),
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
    channel: body.channel,
  };

  try {
    const payment = await submitPayment(paymentData);
    res.json(payment);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PAYMENT',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PAYMENT_AUTHORISATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { submitTaxPayment, TAX_ACCOUNTS } = require('../../services/verticals/3640b94c');

const router = express.Router();

router.get('/api/3640b94c/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(TAX_ACCOUNTS).map((account) => ({
      accountId: account.accountId,
      taxType: account.taxType,
      assessmentCycle: account.assessmentCycle,
      balance: account.balance,
    })),
  });
});

router.post('/api/3640b94c/payment', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const payment = await submitTaxPayment({
      taxAccount: valueOrDefault('taxAccount', 'TAX-IIT-2026'),
      fromAccount: valueOrDefault('fromAccount', 'ACCT-1001'),
      paymentMode: valueOrDefault('paymentMode', 'ibanking'),
      amount: valueOrDefault('amount', 1284.5),
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
      code: 'PAYMENT_POSTING_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const {
  submitPayment,
  ACCOUNT,
  ACCOUNTS,
  BALANCES,
  TRANSACTIONS,
  PAYEES,
  BATCHES,
} = require('../../services/verticals/947c7934');

const router = express.Router();

router.get('/api/947c7934/account', (_req, res) => {
  res.json({
    account: ACCOUNT,
    accounts: ACCOUNTS,
    balances: BALANCES,
    transactions: TRANSACTIONS,
    payees: PAYEES,
    batches: BATCHES,
  });
});

router.post('/api/947c7934/payments', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitPayment({
      fromAccount: body.fromAccount,
      paymentType: body.paymentType,
      batchId: body.batchId,
      payeeId: body.payeeId,
      amountCents: body.amountCents,
      memo: body.memo,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PAYMENT_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

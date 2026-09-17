const express = require('express');
const path = require('path');
const {
  submitTransfer,
  ACCOUNTS,
  CLIENT,
  DEFAULT_FROM_ACCOUNT,
  DEFAULT_TO_ACCOUNT,
} = require('../../services/verticals/4da81799');

const router = express.Router();

router.get('/4da81799', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '4da81799.html'));
});

router.get('/api/4da81799/accounts', (_req, res) => {
  res.json({
    client: CLIENT,
    defaultFromAccount: DEFAULT_FROM_ACCOUNT,
    defaultToAccount: DEFAULT_TO_ACCOUNT,
    accounts: Object.values(ACCOUNTS).map((account) => ({
      accountId: account.accountId,
      displayNumber: account.displayNumber,
      label: account.label,
      currency: account.currency,
      availableBalance: account.availableBalance,
    })),
  });
});

router.post('/api/4da81799/transfer', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await submitTransfer({
      fromAccount: body.fromAccount,
      toAccount: body.toAccount,
      amount: body.amount,
      memo: body.memo,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_TRANSFER_REQUEST',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'TRANSFER_SETTLEMENT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const path = require('path');
const {
  processTransfer, ValidationError, ACCOUNTS, EXTERNAL_ACCOUNTS, TRANSACTIONS,
} = require('../../services/verticals/webster');

const router = express.Router();

router.get('/webster', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'webster.html'));
});

router.get('/api/webster/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, externalAccounts: EXTERNAL_ACCOUNTS, transactions: TRANSACTIONS });
});

router.post('/api/webster/transfer', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await processTransfer({
      fromAccount: body.fromAccount,
      toAccount: body.toAccount,
      amount: body.amount,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
        errorClass: 'ValidationError',
        code: 'INVALID_TRANSFER',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'TRANSFER_FAILED',
      transferId: error.transferId || req.requestId,
    });
  }
});

module.exports = router;

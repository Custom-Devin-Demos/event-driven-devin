const express = require('express');
const path = require('path');
const { processTransfer, ACCOUNTS } = require('../../services/verticals/718eb882');

const router = express.Router();

router.get('/718eb882', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '718eb882.html'));
});

router.get('/api/718eb882/accounts', (_req, res) => {
  res.json({
    accounts: ACCOUNTS.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      balance: account.balance,
    })),
  });
});

router.post('/api/718eb882/transfer', async (req, res) => {
  try {
    const result = await processTransfer(req.body);
    res.json(result);
  } catch (error) {
    const clientErrors = ['UNKNOWN_ACCOUNT', 'INVALID_AMOUNT', 'LIMIT_EXCEEDED', 'INSUFFICIENT_FUNDS'];
    res.status(clientErrors.includes(error.code) ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TRANSFER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const path = require('path');
const { processTransfer, ACCOUNTS, TRANSACTIONS } = require('../../services/verticals/bac');

const router = express.Router();

router.get('/bac', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'bac.html'));
});

router.get('/api/bac/cuentas', (_req, res) => {
  res.json({ accounts: ACCOUNTS, transactions: TRANSACTIONS });
});

router.post('/api/bac/transferencia', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await processTransfer({
      fromAccount: body.fromAccount,
      toAccount: body.toAccount,
      amount: body.amount,
      accountTier: body.accountTier,
      description: body.description,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'TRANSFER_PROCESSING_FAILED',
      transferId: error.transferId || req.requestId,
    });
  }
});

module.exports = router;

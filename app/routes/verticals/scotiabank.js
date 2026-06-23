const express = require('express');
const { processETransfer, ACCOUNTS, TRANSACTIONS } = require('../../services/verticals/scotiabank');

const router = express.Router();

/**
 * GET /api/scotiabank/accounts — returns account list and recent transactions
 */
router.get('/api/scotiabank/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/scotiabank/etransfer — process an Interac e-Transfer
 */
router.post('/api/scotiabank/etransfer', async (req, res) => {
  try {
    const result = await processETransfer({
      fromAccount: req.body.fromAccount || 'ACCT-CHQ-4901',
      recipient: req.body.recipient || 'sarah.m@email.ca',
      amount: req.body.amount || 250,
      accountType: req.body.accountType || 'ultimate',
      userId: req.body.userId || 'usr_scotiabank_1',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ETRANSFER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

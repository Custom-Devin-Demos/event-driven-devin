const express = require('express');
const { processETransfer, ACCOUNTS, TRANSACTIONS } = require('../../services/verticals/e433d32d');

const router = express.Router();

/**
 * GET /api/e433d32d/accounts — returns account list and recent transactions
 */
router.get('/api/e433d32d/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/e433d32d/etransfer — process an Interac e-Transfer
 */
router.post('/api/e433d32d/etransfer', async (req, res) => {
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

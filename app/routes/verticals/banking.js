const express = require('express');
const { processTransfer, ACCOUNTS, TRANSACTIONS } = require('../../services/verticals/banking');

const router = express.Router();

/**
 * GET /api/banking/accounts — returns account list and recent transactions
 */
router.get('/api/banking/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/banking/transfer — process a fund transfer
 */
router.post('/api/banking/transfer', async (req, res) => {
  try {
    const result = await processTransfer({
      fromAccount: req.body.fromAccount || 'ACCT-1001',
      toAccount: req.body.toAccount || 'ACCT-1002',
      amount: req.body.amount || 500,
      accountTier: req.body.accountTier || 'Premium',
      userId: req.body.userId || 'usr_banking_1',
    });
    res.json({
      ...result,
      fee: result.receipt.fee,
      debitAmount: result.receipt.totalDebit,
    });
  } catch (error) {
    const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

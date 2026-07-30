const express = require('express');
const { processTransfer, ACCOUNTS, TRANSACTIONS } = require('../../services/verticals/mtb');

const router = express.Router();

/**
 * GET /api/mtb/accounts — returns account list and recent transactions
 */
router.get('/api/mtb/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/mtb/transfer — process a fund transfer
 */
router.post('/api/mtb/transfer', async (req, res) => {
  try {
    const result = await processTransfer({
      fromAccount: req.body.fromAccount || 'ACCT-1001',
      toAccount: req.body.toAccount || 'ACCT-1002',
      amount: req.body.amount || 500,
      accountTier: req.body.accountTier || 'Premium',
      userId: req.body.userId || 'usr_mtb_1',
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
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processPayment, ACCOUNTS, PAYEES, TRANSACTIONS } = require('../../services/verticals/8d933e67');

const router = express.Router();

/**
 * GET /api/8d933e67/accounts — returns accounts, saved payees, and recent activity
 */
router.get('/api/8d933e67/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, payees: PAYEES, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/8d933e67/payment — process a consumer payment to a payee
 */
router.post('/api/8d933e67/payment', async (req, res) => {
  try {
    const result = await processPayment({
      fromAccount: req.body.fromAccount || 'TD-CHK-4417',
      payeeId: req.body.payeeId || 'PAYEE-1001',
      payeeName: req.body.payeeName || 'Jordan Rivera',
      amount: req.body.amount || 120,
      rail: req.body.rail || 'p2p-instant',
      memo: req.body.memo || '',
      userId: req.body.userId || 'usr_tdbank_1',
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

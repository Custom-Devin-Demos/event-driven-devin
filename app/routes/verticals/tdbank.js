const express = require('express');
const { processPayment, ACCOUNTS, PAYEES, TRANSACTIONS } = require('../../services/verticals/tdbank');

const router = express.Router();

/**
 * GET /api/tdbank/accounts — returns accounts, saved payees, and recent activity
 */
router.get('/api/tdbank/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, payees: PAYEES, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/tdbank/payment — process a consumer payment to a payee
 */
router.post('/api/tdbank/payment', async (req, res) => {
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

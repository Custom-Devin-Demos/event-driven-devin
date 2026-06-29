const express = require('express');
const { processPayment, ACCOUNTS, PAYEES, TRANSACTIONS } = require('../../services/verticals/keybank');

const router = express.Router();

/**
 * GET /api/keybank/accounts — returns accounts, saved payees, and recent activity
 */
router.get('/api/keybank/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, payees: PAYEES, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/keybank/payment — process a consumer payment to a payee
 */
router.post('/api/keybank/payment', async (req, res) => {
  try {
    const result = await processPayment({
      fromAccount: req.body.fromAccount || 'KEY-CHK-7741',
      payeeId: req.body.payeeId || 'PAYEE-2001',
      payeeName: req.body.payeeName || 'Morgan Avery',
      amount: req.body.amount || 95,
      rail: req.body.rail || 'zelle-instant',
      memo: req.body.memo || '',
      userId: req.body.userId || 'usr_keybank_1',
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

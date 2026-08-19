const express = require('express');
const { processPayment, ACCOUNTS, RECIPIENTS, TRANSACTIONS } = require('../../services/verticals/6820f69a');

const router = express.Router();

/**
 * GET /api/6820f69a/accounts — returns accounts, saved recipients, and recent activity
 */
router.get('/api/6820f69a/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recipients: RECIPIENTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/6820f69a/payment — process a consumer payment to a saved recipient
 */
router.post('/api/6820f69a/payment', async (req, res) => {
  try {
    const result = await processPayment({
      fromAccount: req.body.fromAccount || '53-CHK-2208',
      recipientId: req.body.recipientId || 'RCPT-2001',
      recipientName: req.body.recipientName || 'Alex Whitfield',
      amount: req.body.amount || 85,
      deliveryOption: req.body.deliveryOption || 'zelle-instant',
      memo: req.body.memo || '',
      userId: req.body.userId || 'usr_fifththird_1',
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

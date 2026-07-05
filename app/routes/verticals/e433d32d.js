const express = require('express');
const { processETransfer, ACCOUNTS, RECIPIENTS, TRANSACTIONS } = require('../../services/verticals/e433d32d');

const router = express.Router();

/**
 * GET /api/e433d32d/accounts — returns accounts, recipients and recent transactions
 */
router.get('/api/e433d32d/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recipients: RECIPIENTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/e433d32d/etransfer — process a transfer to a recipient
 */
router.post('/api/e433d32d/etransfer', async (req, res) => {
  try {
    const result = await processETransfer({
      fromAccount: req.body.fromAccount || 'ACCT-CHQ-4901',
      recipientId: req.body.recipientId || 'REC-1002',
      recipientName: req.body.recipientName || 'Michael Chen',
      recipient: req.body.recipient || 'michael.chen@email.ca',
      bank: req.body.bank || 'RBC Royal Bank',
      transferType: req.body.transferType || 'interac',
      amount: req.body.amount || 250,
      package: req.body.package || 'ultimate',
      memo: req.body.memo || '',
      userId: req.body.userId || 'usr_e433d32d_1',
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

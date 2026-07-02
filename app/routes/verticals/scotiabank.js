const express = require('express');
const { processETransfer, ACCOUNTS, RECIPIENTS, TRANSACTIONS } = require('../../services/verticals/scotiabank');

const router = express.Router();

/**
 * GET /api/scotiabank/accounts — returns accounts, recipients and recent transactions
 */
router.get('/api/scotiabank/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recipients: RECIPIENTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/scotiabank/etransfer — process a transfer to a recipient
 */
router.post('/api/scotiabank/etransfer', async (req, res) => {
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

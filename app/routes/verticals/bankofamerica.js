const express = require('express');
const { processTransfer, ACCOUNTS, RECIPIENTS, TRANSACTIONS } = require('../../services/verticals/bankofamerica');

const router = express.Router();

/**
 * GET /api/bankofamerica/accounts — returns accounts, saved recipients, and recent activity
 */
router.get('/api/bankofamerica/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, recipients: RECIPIENTS, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/bankofamerica/transfer — process a consumer transfer (Zelle or wire)
 */
router.post('/api/bankofamerica/transfer', async (req, res) => {
  try {
    const result = await processTransfer({
      fromAccount: req.body.fromAccount || 'BOA-ADV-7741',
      recipient: req.body.recipient || 'maria.gonzalez@email.com',
      amount: req.body.amount || 200,
      transferType: req.body.transferType || 'zelle',
      rewardsTier: req.body.rewardsTier || 'platinum-honors',
      memo: req.body.memo || '',
      userId: req.body.userId || 'usr_boa_1',
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
      code: error.code || 'TRANSFER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

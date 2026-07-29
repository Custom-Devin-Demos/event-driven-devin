const express = require('express');
const path = require('path');
const { searchTransactions, ACCOUNTS, TRANSACTIONS, CATEGORIES } = require('../../services/verticals/61875a84');

const router = express.Router();

router.get('/61875a84', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '61875a84.html'));
});

/**
 * GET /api/61875a84/accounts — accounts, categories, and recent activity
 */
router.get('/api/61875a84/accounts', (_req, res) => {
  res.json({ accounts: ACCOUNTS, categories: CATEGORIES, recentTransactions: TRANSACTIONS });
});

/**
 * POST /api/61875a84/transactions — search account activity for a statement period
 */
router.post('/api/61875a84/transactions', async (req, res) => {
  try {
    const result = await searchTransactions({
      accountId: req.body.accountId || 'BOA-ADV-7522',
      period: req.body.period || 'transaction-history',
      category: req.body.category || 'all',
      query: req.body.query || '',
      userId: req.body.userId || 'usr_boa_demo',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const {
  sendMoney,
  requestMoney,
  FUNDING_ACCOUNTS,
  RECIPIENTS,
} = require('../../services/verticals/6f43e66c');

const router = express.Router();

/**
 * GET /api/6f43e66c/context — eligible funding accounts and enrolled recipients
 */
router.get('/api/6f43e66c/context', (_req, res) => {
  res.json({
    accounts: FUNDING_ACCOUNTS.map(({ id, productLabel, last4, availableBalance }) => ({
      id, productLabel, last4, availableBalance,
    })),
    recipients: RECIPIENTS,
  });
});

/**
 * POST /api/6f43e66c/send — send money to an enrolled Zelle® recipient
 */
router.post('/api/6f43e66c/send', async (req, res) => {
  try {
    const confirmation = await sendMoney({
      fromAccountId: req.body.fromAccountId,
      recipientId: req.body.recipientId,
      amount: req.body.amount,
      memo: req.body.memo,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ZELLE_SEND_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/6f43e66c/request — request money from an enrolled Zelle® recipient
 */
router.post('/api/6f43e66c/request', async (req, res) => {
  try {
    const request = await requestMoney({
      fromAccountId: req.body.fromAccountId,
      recipientId: req.body.recipientId,
      amount: req.body.amount,
      memo: req.body.memo,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(request);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ZELLE_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

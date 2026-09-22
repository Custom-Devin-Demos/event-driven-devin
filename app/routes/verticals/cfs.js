const express = require('express');
const path = require('path');
const {
  submitWithdrawal,
  MEMBER_ACCOUNTS,
} = require('../../services/verticals/cfs');

const router = express.Router();

router.get('/cfs', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'cfs.html'));
});

router.get('/api/cfs/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(MEMBER_ACCOUNTS).map((account) => ({
      memberAccountId: account.memberAccountId,
      memberName: account.memberName,
      productLabel: account.productLabel,
      balance: account.balance,
      preservation: account.preservation,
      fund: account.fund,
      usi: account.usi,
      paymentDestination: account.paymentDestination,
      paymentBsb: account.paymentBsb,
      paymentAccountEnding: account.paymentAccountEnding,
    })),
  });
});

router.post('/api/cfs/withdrawal', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const withdrawal = await submitWithdrawal({
      memberAccountId: valueOrDefault('memberAccountId', 'CFS-2044186'),
      amountBasis: valueOrDefault('amountBasis', 'amount'),
      withdrawalAmount: valueOrDefault('withdrawalAmount', 45000),
      paymentDestination: valueOrDefault(
        'paymentDestination',
        'Commonwealth Bank •••• 4471',
      ),
      paymentDate: valueOrDefault('paymentDate', '2026-09-18'),
      memberDeclaration: valueOrDefault('memberDeclaration', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(withdrawal);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_WITHDRAWAL_REQUEST',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'WITHDRAWAL_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

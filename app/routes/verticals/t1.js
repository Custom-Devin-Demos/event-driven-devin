const express = require('express');
const path = require('path');
const {
  createPaymentLink,
  MERCHANT,
  PAYMENT_METHODS,
  RECENT_LINKS,
  ValidationError,
} = require('../../services/verticals/t1');

const router = express.Router();

router.get('/t1', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 't1.html'));
});

router.get('/api/t1/merchant', (_req, res) => {
  res.json({
    merchant: MERCHANT,
    paymentMethods: PAYMENT_METHODS,
    recentLinks: RECENT_LINKS,
  });
});

router.post('/api/t1/payment-links', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await createPaymentLink({
      amount: body.amount,
      concept: body.concept,
      methods: body.methods,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: 'ValidationError',
        code: 'INVALID_PAYMENT_LINK',
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PAYMENT_LINK_CREATION_FAILED',
      linkId: error.linkId || req.requestId,
    });
  }
});

module.exports = router;

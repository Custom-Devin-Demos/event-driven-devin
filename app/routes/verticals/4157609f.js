const express = require('express');
const { initiatePayment, resetGateway, getOverview } = require('../../services/verticals/4157609f');

const router = express.Router();

router.get('/api/4157609f/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/4157609f/payments', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await initiatePayment({
      fromAccount: body.fromAccount,
      payIdType: body.payIdType,
      payId: body.payId,
      amountCents: body.amountCents,
      description: body.description,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/4157609f/payments/reset', (_req, res) => {
  res.json(resetGateway());
});

module.exports = router;

const express = require('express');
const { listOffers, startFreeTrial } = require('../../services/verticals/096058b1');

const router = express.Router();

router.get('/api/096058b1/offers', (req, res) => {
  res.json({ success: true, offers: listOffers() });
});

router.post('/api/096058b1/free-trial', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startFreeTrial({
      preConfigItems: body.preConfigItems,
      intent: body.intent,
      trialDays: body.trialDays,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'FREE_TRIAL_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

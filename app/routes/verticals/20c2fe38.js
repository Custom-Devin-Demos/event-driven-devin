const express = require('express');
const { listPlans, startSubscription } = require('../../services/verticals/20c2fe38');

const router = express.Router();

const MAX_IDENTITY_LENGTH = 200;

function identityField(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTITY_LENGTH ? value : undefined;
}

router.get('/api/20c2fe38/plans', (_req, res) => {
  res.json(listPlans());
});

router.post('/api/20c2fe38/subscribe', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startSubscription({
      select: body.select,
      devinUserId: identityField(body.devinUserId),
      devinOrgId: identityField(body.devinOrgId),
      devinEmail: identityField(body.devinEmail),
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SUBSCRIBE_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { inquireClaim, listClaims } = require('../../services/verticals/95d1a7d1');

const router = express.Router();

router.get('/api/95d1a7d1/claims', (_req, res) => {
  res.json({ claims: listClaims() });
});

router.post('/api/95d1a7d1/inquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await inquireClaim({
      claimId: body.claimId,
      userId: body.userId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

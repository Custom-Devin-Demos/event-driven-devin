const express = require('express');
const { listOffers, processInquiry } = require('../../services/verticals/4d820a2b');

const router = express.Router();

router.get('/api/4d820a2b/offers', (_req, res) => {
  res.json(listOffers());
});

router.post('/api/4d820a2b/inquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await processInquiry({
      promotionId: body.promotionId,
      lines: body.lines,
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
      code: error.code || 'SWITCH_QUOTE_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

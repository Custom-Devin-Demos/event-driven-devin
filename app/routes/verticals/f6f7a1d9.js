const express = require('express');
const {
  estimateAudienceReach,
  PARTNERS,
  CHANNEL_SCOPES,
  SEGMENTS,
  MARKETS,
} = require('../../services/verticals/f6f7a1d9');

const router = express.Router();

router.get('/api/f6f7a1d9/catalog', (_req, res) => {
  res.json({
    segments: SEGMENTS.map(({ key, code, label }) => ({ key, code, label })),
    markets: MARKETS.map(({ key, label, households }) => ({ key, label, households })),
    channels: Object.entries(CHANNEL_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      partnerCount: scope.partners.length,
    })),
    partners: PARTNERS.map(({ key, label, channel }) => ({ key, label, channel })),
  });
});

router.post('/api/f6f7a1d9/audience-reach', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await estimateAudienceReach({
      company: body.company,
      email: body.email,
      segment: body.segment,
      market: body.market,
      channels: body.channels,
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
      code: error.code || 'AUDIENCE_REACH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const {
  runSourceOrder,
  NETWORK_MEMBERS,
  SOURCE_SCOPES,
  NETWORK_RATE_PCT,
} = require('../../services/verticals/98cd161c');

const router = express.Router();

router.get('/api/98cd161c/network', (_req, res) => {
  res.json({
    networkRatePct: NETWORK_RATE_PCT,
    collateral: 'None',
    members: Object.entries(NETWORK_MEMBERS).map(([key, member]) => ({
      key,
      label: member.label,
      assetsLabel: member.assetsLabel,
      state: member.state,
      network: member.network,
    })),
    scopeOptions: Object.entries(SOURCE_SCOPES).map(([key, option]) => ({
      key,
      label: option.label,
      memberCount: option.members.length,
    })),
  });
});

router.post('/api/98cd161c/source-order', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runSourceOrder({
      institution: body.institution,
      targetBalance: body.targetBalance,
      scope: body.scope,
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
      code: error.code || 'SOURCE_ORDER_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

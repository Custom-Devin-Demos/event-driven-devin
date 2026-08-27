const express = require('express');
const {
  requestPayout,
  EARNINGS_SOURCES,
  ADVANCE_RECOUPMENT,
} = require('../../services/verticals/7a6ccff6');

const router = express.Router();

router.get('/api/7a6ccff6/earnings', (_req, res) => {
  res.json({
    earningsSources: EARNINGS_SOURCES.map((source) => ({
      code: source.code,
      name: source.name,
      territory: source.territory,
      grossEarningsUsd: source.grossEarningsUsd,
      streamsMillions: source.streamsMillions,
    })),
    advances: Object.entries(ADVANCE_RECOUPMENT).map(([code, advance]) => ({
      code,
      ...advance,
    })),
  });
});

router.post('/api/7a6ccff6/request-payout', async (req, res) => {
  try {
    const result = await requestPayout({
      earningsSource: req.body.earningsSource || 'neighbouring-rights',
      advance: req.body.advance || 'album-cycle-2024',
      accountNumber: req.body.accountNumber,
      statementPeriod: req.body.statementPeriod,
      payoutMethod: req.body.payoutMethod,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PAYOUT_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

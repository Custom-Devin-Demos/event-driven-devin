const express = require('express');
const {
  runRateCheck,
  LOAN_PROGRAMS,
  PROGRAM_SCOPES,
  CREDIT_BANDS,
} = require('../../services/verticals/b62bfb77');

const router = express.Router();

router.get('/api/b62bfb77/programs', (req, res) => {
  res.json({
    programs: Object.entries(LOAN_PROGRAMS).map(([key, program]) => ({
      key,
      label: program.label,
      family: program.family,
      termYears: program.termYears,
      minDownPct: program.minDownPct,
    })),
    scopeOptions: Object.entries(PROGRAM_SCOPES).map(([key, option]) => ({
      key,
      label: option.label,
      programCount: option.programs.length,
    })),
    creditBands: Object.entries(CREDIT_BANDS).map(([key, band]) => ({ key, label: band.label })),
  });
});

router.post('/api/b62bfb77/rate-check', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runRateCheck({
      name: body.name,
      homePrice: body.homePrice,
      downPayment: body.downPayment,
      zip: body.zip,
      creditBand: body.creditBand,
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
      code: error.code || 'RATE_CHECK_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

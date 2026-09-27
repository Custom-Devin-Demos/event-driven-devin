const express = require('express');
const path = require('path');
const {
  generateScorecard,
  ISSUERS,
} = require('../../services/verticals/ratingsdirect');

const router = express.Router();

router.get('/ratingsdirect', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'ratingsdirect.html'));
});

router.get('/api/ratingsdirect/issuers', (_req, res) => {
  res.json({
    issuers: Object.values(ISSUERS),
  });
});

router.post('/api/ratingsdirect/scorecard', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const scorecard = await generateScorecard({
      issuerId: valueOrDefault('issuerId', 'SPG-ISS-4471028'),
      businessRiskProfile: valueOrDefault('businessRiskProfile', 'satisfactory'),
      financialRiskProfile: valueOrDefault('financialRiskProfile', 'significant'),
      countryRiskScore: valueOrDefault('countryRiskScore', 2),
      industryRiskScore: valueOrDefault('industryRiskScore', 3),
      ffoToDebtPercent: valueOrDefault('ffoToDebtPercent', 14.8),
      debtToEbitda: valueOrDefault('debtToEbitda', 4.6),
      ebitdaInterestCoverage: valueOrDefault('ebitdaInterestCoverage', 3.4),
      liquidityAssessment: valueOrDefault('liquidityAssessment', 'adequate'),
      comparableRatingsAdjustment: valueOrDefault('comparableRatingsAdjustment', 0),
      analystNotes: valueOrDefault(
        'analystNotes',
        'Regulatory reset locks in allowed revenue to 2031; capex programme funded with a committed RCF. Committee package prepared for the 2 October session.',
      ),
      criteriaConfirmed: valueOrDefault('criteriaConfirmed', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(scorecard);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_SCORECARD_REQUEST',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SCORECARD_GENERATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

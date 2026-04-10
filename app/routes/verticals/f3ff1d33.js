const express = require('express');
const { analyzePortfolio, PORTFOLIO_DATA, SEGMENT_WEIGHTS } = require('../../services/verticals/f3ff1d33');

const router = express.Router();

/**
 * GET /api/f3ff1d33/segments — returns segment metadata
 */
router.get('/api/f3ff1d33/segments', (_req, res) => {
  res.json({ segments: Object.keys(PORTFOLIO_DATA), weights: SEGMENT_WEIGHTS });
});

/**
 * POST /api/f3ff1d33/analyze — run portfolio segment analysis
 */
router.post('/api/f3ff1d33/analyze', async (req, res) => {
  try {
    const result = await analyzePortfolio({
      segment: req.body.segment || 'Application Software',
      quarter: req.body.quarter || 'Q1',
      metricFocus: req.body.metricFocus || 'revenue',
      companyFilter: req.body.companyFilter,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ANALYSIS_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

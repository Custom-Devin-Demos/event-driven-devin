const express = require('express');
const { runPortfolioAnalysis, FUND_STRATEGIES, VINTAGE_PERFORMANCE } = require('../../services/verticals/alpha-wave-global');

const router = express.Router();

/**
 * GET /api/alpha-wave-global/funds — returns fund strategy and vintage data
 */
router.get('/api/alpha-wave-global/funds', (_req, res) => {
  res.json({ strategies: FUND_STRATEGIES, vintages: VINTAGE_PERFORMANCE });
});

/**
 * POST /api/alpha-wave-global/analyze — run a portfolio analysis
 */
router.post('/api/alpha-wave-global/analyze', async (req, res) => {
  try {
    const result = await runPortfolioAnalysis({
      fundStrategy: req.body.fundStrategy || 'venture-growth',
      vintageYear: req.body.vintageYear || '2023',
      analysisType: req.body.analysisType || 'performance',
      investorId: req.body.investorId,
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

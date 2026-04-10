const express = require('express');
const { runPortfolioAnalysis, FUND_STRATEGIES, VINTAGE_PERFORMANCE } = require('../../services/verticals/53a9884e');

const router = express.Router();

/**
 * GET /api/53a9884e/funds — returns fund strategy and vintage data
 */
router.get('/api/53a9884e/funds', (_req, res) => {
  res.json({ strategies: FUND_STRATEGIES, vintages: VINTAGE_PERFORMANCE });
});

/**
 * POST /api/53a9884e/analyze — run a portfolio analysis
 */
router.post('/api/53a9884e/analyze', async (req, res) => {
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

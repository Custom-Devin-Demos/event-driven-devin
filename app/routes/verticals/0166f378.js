const express = require('express');
const { loadPortfolioSummary, LATENCY_SLO, snowflakeMode } = require('../../services/verticals/0166f378');
const { PORTFOLIO } = require('../../services/verticals/0166f378-portfolio');

const router = express.Router();

function isReproductionRequest(req) {
  return (Boolean(req.headers['x-synthetic']) || req.query.reports === 'off') && process.env.NODE_ENV !== 'production';
}

router.get('/api/0166f378/config', (req, res) => {
  res.json({
    success: true,
    owner: PORTFOLIO.owner,
    accounts: PORTFOLIO.accounts.map(({ accountId, name, type }) => ({ accountId, name, type })),
    latencyBudgetMs: LATENCY_SLO.budgetMs,
    snowflakeMode: snowflakeMode(),
  });
});

router.get('/api/0166f378/portfolio-summary', async (req, res) => {
  try {
    const result = await loadPortfolioSummary({
      requestId: req.requestId,
      ownerId: req.query.ownerId,
      asOf: req.query.asOf,
      reproduction: isReproductionRequest(req),
      devinUserId: req.query.devinUserId || req.headers['x-devin-user-id'],
      devinOrgId: req.query.devinOrgId || req.headers['x-devin-org-id'],
      devinEmail: req.query.devinEmail || req.headers['x-devin-email'],
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PORTFOLIO_SUMMARY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

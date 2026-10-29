const express = require('express');
const {
  listPortfolios,
  openPortfolio,
  overrideCarbonIntensity,
  resetDemoState,
  runPositionsLoad,
} = require('../../services/verticals/62b9367b');

const router = express.Router();

function sendError(req, res, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    reference: error.reference,
    requestId: req.requestId,
  });
}

router.get('/api/62b9367b/portfolios', (_req, res) => {
  res.json(listPortfolios());
});

router.get('/api/62b9367b/portfolios/:portfolioId', async (req, res) => {
  try {
    const result = await openPortfolio(req.params.portfolioId, {
      devinUserId: req.get('x-devin-user-id') || '',
      devinOrgId: req.get('x-devin-org-id') || '',
      devinEmail: req.get('x-devin-email') || '',
    });
    res.json(result);
  } catch (error) {
    sendError(req, res, error, 'PORTFOLIO_UNAVAILABLE');
  }
});

router.post('/api/62b9367b/positions-load', (req, res) => {
  try {
    res.json(runPositionsLoad());
  } catch (error) {
    sendError(req, res, error, 'POSITIONS_LOAD_FAILED');
  }
});

router.post('/api/62b9367b/portfolios/:portfolioId/carbon-override', (req, res) => {
  try {
    res.json(overrideCarbonIntensity(req.params.portfolioId, req.body || {}));
  } catch (error) {
    sendError(req, res, error, 'OVERRIDE_FAILED');
  }
});

router.post('/api/62b9367b/reset', (_req, res) => {
  resetDemoState();
  res.json({ success: true });
});

module.exports = router;

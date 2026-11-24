const express = require('express');
const {
  searchSite,
  SCOPES,
  DEFAULT_QUERY,
  MAX_RESULTS,
  LATENCY_SLO,
} = require('../../services/verticals/ea983805');

const router = express.Router();

router.get('/api/ea983805/config', (_req, res) => {
  res.json({
    success: true,
    scopes: SCOPES,
    defaultQuery: DEFAULT_QUERY,
    maxResults: MAX_RESULTS,
    budgetMs: LATENCY_SLO.budgetMs,
  });
});

router.post('/api/ea983805/search', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchSite({
      q: body.q,
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
      code: error.code || 'SEARCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

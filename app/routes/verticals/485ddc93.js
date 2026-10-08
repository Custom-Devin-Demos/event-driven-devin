const express = require('express');
const {
  searchObituaries,
  REGIONS,
  SEARCH_SCOPES,
  DATE_RANGES,
} = require('../../services/verticals/485ddc93');

const router = express.Router();

router.get('/api/485ddc93/regions', (req, res) => {
  res.json({
    regions: REGIONS.map(({ key, label, funeralHomes }) => ({ key, label, funeralHomes })),
    scopes: Object.entries(SEARCH_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      regionCount: scope.regions.length,
    })),
    dateRanges: Object.entries(DATE_RANGES).map(([key, range]) => ({ key, label: range.label })),
  });
});

router.post('/api/485ddc93/obituary-search', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchObituaries({
      name: body.name,
      dateRange: body.dateRange,
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
      code: error.code || 'OBITUARY_SEARCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

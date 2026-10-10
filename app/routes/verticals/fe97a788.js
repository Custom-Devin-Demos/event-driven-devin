const express = require('express');
const {
  runEndpointQuery,
  PIPES,
  TIME_RANGES,
  SCOPE_OPTIONS,
} = require('../../services/verticals/fe97a788');

const router = express.Router();

router.get('/api/fe97a788/pipes', (req, res) => {
  res.json({
    pipes: Object.entries(PIPES).map(([key, pipe]) => ({
      key,
      label: pipe.label,
      datasource: pipe.datasource,
      dimension: pipe.dimension,
      endpoint: `/v0/pipes/${key}.json`,
    })),
    timeRanges: Object.entries(TIME_RANGES).map(([key, range]) => ({
      key,
      label: range.label,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      shardCount: option.shards.length,
    })),
  });
});

router.post('/api/fe97a788/query', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runEndpointQuery({
      pipe: body.pipe,
      timeRange: body.timeRange,
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
      code: error.code || 'ENDPOINT_QUERY_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

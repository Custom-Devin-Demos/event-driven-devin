const express = require('express');
const { processQuery, CATALOG, DISTRIBUTION_CENTERS } = require('../../services/verticals/20cd1314');

const router = express.Router();

/**
 * GET /api/20cd1314/catalog — returns the Mars product catalog
 */
router.get('/api/20cd1314/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * GET /api/20cd1314/facilities — returns all distribution center statuses
 */
router.get('/api/20cd1314/facilities', (_req, res) => {
  res.json({ facilities: DISTRIBUTION_CENTERS });
});

/**
 * POST /api/20cd1314/query — process a natural language supply chain query
 */
router.post('/api/20cd1314/query', async (req, res) => {
  try {
    const result = await processQuery({
      query: req.body.query || '',
      region: req.body.region || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUERY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processQuery, CATALOG, DISTRIBUTION_CENTERS } = require('../../services/verticals/eb3df102');

const router = express.Router();

/**
 * GET /api/eb3df102/catalog — returns the Sysco product catalog
 */
router.get('/api/eb3df102/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * GET /api/eb3df102/facilities — returns all distribution center statuses
 */
router.get('/api/eb3df102/facilities', (_req, res) => {
  res.json({ facilities: DISTRIBUTION_CENTERS });
});

/**
 * POST /api/eb3df102/query — process a natural language supply chain query
 */
router.post('/api/eb3df102/query', async (req, res) => {
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

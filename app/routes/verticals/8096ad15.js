const express = require('express');
const { processQuery, fetchOnPremInventory, CATALOG, DISTRIBUTION_CENTERS } = require('../../services/verticals/8096ad15');

const router = express.Router();

/**
 * GET /api/8096ad15/catalog — returns the Eli Lilly product catalog
 */
router.get('/api/8096ad15/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * GET /api/8096ad15/facilities — returns all distribution center statuses
 */
router.get('/api/8096ad15/facilities', (_req, res) => {
  res.json({ facilities: DISTRIBUTION_CENTERS });
});

/**
 * GET /api/8096ad15/onprem-inventory — proxies live stock from the on-prem legacy system
 */
router.get('/api/8096ad15/onprem-inventory', async (_req, res) => {
  const data = await fetchOnPremInventory();
  if (!data) {
    return res.status(503).json({ source: 'on-prem', available: false, message: 'Legacy on-prem inventory system unreachable' });
  }
  res.json(data);
});

/**
 * POST /api/8096ad15/query — process a natural language supply chain query
 */
router.post('/api/8096ad15/query', async (req, res) => {
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

const express = require('express');
const { processQuery, fetchOnPremInventory, CATALOG, DISTRIBUTION_CENTERS } = require('../../services/verticals/lilly');

const router = express.Router();

/**
 * GET /api/lilly/catalog — returns the Eli Lilly product catalog
 */
router.get('/api/lilly/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * GET /api/lilly/facilities — returns all distribution center statuses
 */
router.get('/api/lilly/facilities', (_req, res) => {
  res.json({ facilities: DISTRIBUTION_CENTERS });
});

/**
 * GET /api/lilly/onprem-inventory — proxies live stock from the on-prem legacy system
 */
router.get('/api/lilly/onprem-inventory', async (_req, res) => {
  const data = await fetchOnPremInventory();
  if (!data) {
    return res.status(503).json({ source: 'on-prem', available: false, message: 'Legacy on-prem inventory system unreachable' });
  }
  res.json(data);
});

/**
 * POST /api/lilly/query — process a natural language supply chain query
 */
router.post('/api/lilly/query', async (req, res) => {
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

const express = require('express');
const { runInquiry, DIVISIONS, ROLE_CATALOG } = require('../../services/verticals/89c1f355');

const router = express.Router();

/**
 * GET /api/89c1f355/roles — returns division and role catalog data
 */
router.get('/api/89c1f355/roles', (_req, res) => {
  res.json({
    divisions: DIVISIONS.map((d) => ({
      code: d.code,
      name: d.name,
      regions: d.regions,
    })),
    roles: ROLE_CATALOG,
  });
});

/**
 * POST /api/89c1f355/inquiry — run a recruitment inquiry
 */
router.post('/api/89c1f355/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      division: req.body.division || 'investment-banking',
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
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

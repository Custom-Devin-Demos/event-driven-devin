const express = require('express');
const { runInquiry, DATACENTERS, PROCESSOR_CATALOG } = require('../../services/verticals/1a459b91');

const router = express.Router();

/**
 * GET /api/1a459b91/components — returns processor catalog and datacenter data
 */
router.get('/api/1a459b91/components', (_req, res) => {
  res.json({ facilities: DATACENTERS, components: PROCESSOR_CATALOG });
});

/**
 * POST /api/1a459b91/inquiry — run a processor allocation inquiry
 */
router.post('/api/1a459b91/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      facility: req.body.facility || 'hillsboro',
      category: req.body.category || 'core',
      priority: req.body.priority || 'standard',
      partNumber: req.body.partNumber,
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

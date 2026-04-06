const express = require('express');
const { runInquiry, FACILITIES, COMPONENT_CATALOG } = require('../../services/verticals/foxconn');

const router = express.Router();

/**
 * GET /api/foxconn/components — returns component catalog and facility data
 */
router.get('/api/foxconn/components', (_req, res) => {
  res.json({ facilities: FACILITIES, components: COMPONENT_CATALOG });
});

/**
 * POST /api/foxconn/inquiry — run a component supply inquiry
 */
router.post('/api/foxconn/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      facility: req.body.facility || 'zhengzhou',
      category: req.body.category || 'pcb',
      priority: req.body.priority || 'standard',
      partNumber: req.body.partNumber,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
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

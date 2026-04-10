const express = require('express');
const { runInquiry, FACILITIES, COMPONENT_CATALOG } = require('../../services/verticals/acf4303d');

const router = express.Router();

/**
 * GET /api/acf4303d/components — returns component catalog and facility data
 */
router.get('/api/acf4303d/components', (_req, res) => {
  res.json({ facilities: FACILITIES, components: COMPONENT_CATALOG });
});

/**
 * POST /api/acf4303d/inquiry — run a component supply inquiry
 */
router.post('/api/acf4303d/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      facility: req.body.facility || 'zhengzhou',
      category: req.body.category || 'pcb',
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

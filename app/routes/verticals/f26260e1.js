const express = require('express');
const { processCreditReportRequest, CREDIT_PROFILES } = require('../../services/verticals/f26260e1');

const router = express.Router();

/**
 * GET /api/f26260e1/score-models — returns available score models
 */
router.get('/api/f26260e1/score-models', (_req, res) => {
  res.json({
    models: Object.entries(CREDIT_PROFILES).map(([id, p]) => ({
      id,
      label: p.label,
      range: p.range,
    })),
  });
});

/**
 * POST /api/f26260e1/credit-report — generate a free credit report
 */
router.post('/api/f26260e1/credit-report', async (req, res) => {
  try {
    const result = await processCreditReportRequest({
      bureau: req.body.bureau || 'experian',
      scoreModel: req.body.scoreModel || 'fico-8',
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
      code: error.code || 'CREDIT_REPORT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

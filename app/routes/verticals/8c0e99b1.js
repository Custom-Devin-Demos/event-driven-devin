const express = require('express');
const { processDemoRequest, CLOUDSUITES } = require('../../services/verticals/8c0e99b1');

const router = express.Router();

/**
 * GET /api/8c0e99b1/suites — returns available CloudSuite catalog entries
 */
router.get('/api/8c0e99b1/suites', (_req, res) => {
  res.json({
    suites: Object.entries(CLOUDSUITES).map(([id, s]) => ({
      id,
      label: s.label,
      modules: s.modules,
      tier: s.deployment.tier,
    })),
  });
});

/**
 * POST /api/8c0e99b1/demo-request — provision a demo environment
 */
router.post('/api/8c0e99b1/demo-request', async (req, res) => {
  try {
    const result = await processDemoRequest({
      industry: req.body.industry || 'Industrial Manufacturing',
      region: req.body.region || 'us-east',
      modules: req.body.modules || [],
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
      code: error.code || 'DEMO_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

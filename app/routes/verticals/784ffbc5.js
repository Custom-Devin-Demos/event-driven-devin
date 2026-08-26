const express = require('express');
const { submitDemoRequest, DEMO_SOLUTIONS, COMPANY_STATS } = require('../../services/verticals/784ffbc5');

const router = express.Router();

/**
 * GET /api/784ffbc5/solutions — solutions offered on the demo-request form
 */
router.get('/api/784ffbc5/solutions', (_req, res) => {
  res.json({
    solutions: DEMO_SOLUTIONS.map((solution) => ({
      code: solution.code,
      label: solution.label,
    })),
  });
});

/**
 * GET /api/784ffbc5/stats — company stats surfaced on the corporate site
 */
router.get('/api/784ffbc5/stats', (_req, res) => {
  res.json({ stats: COMPANY_STATS });
});

/**
 * POST /api/784ffbc5/demo-request — submit a demo request
 */
router.post('/api/784ffbc5/demo-request', async (req, res) => {
  try {
    const confirmation = await submitDemoRequest({
      solution: req.body.solution || 'cloud4retail',
      company: req.body.company || '',
      name: req.body.name || '',
      email: req.body.email || '',
      message: req.body.message || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DEMO_REQUEST_ROUTING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

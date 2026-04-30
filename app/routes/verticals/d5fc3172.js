const express = require('express');
const { processInquiry, WORKSPACE_REGISTRY, WORKSPACE_PLANS } = require('../../services/verticals/d5fc3172');

const router = express.Router();

/**
 * GET /api/d5fc3172/workspaces — returns workspace registry and plan info
 */
router.get('/api/d5fc3172/workspaces', (_req, res) => {
  res.json({ workspaces: WORKSPACE_REGISTRY, plans: WORKSPACE_PLANS });
});

/**
 * POST /api/d5fc3172/inquiry — process a workspace plan inquiry
 */
router.post('/api/d5fc3172/inquiry', async (req, res) => {
  try {
    const result = await processInquiry({
      workspaceName: req.body.workspaceName || 'Default Workspace',
      plan: req.body.plan || 'business',
      teamSize: req.body.teamSize || 50,
      region: req.body.region || 'us-east-1',
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

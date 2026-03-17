const express = require('express');
const { createDevinSession, SESSIONS, PLAYBOOKS } = require('../../services/verticals/devin');

const router = express.Router();

/**
 * GET /api/devin/sessions — returns recent sessions and available playbooks
 */
router.get('/api/devin/sessions', (_req, res) => {
  res.json({ sessions: SESSIONS, playbooks: PLAYBOOKS });
});

/**
 * POST /api/devin/sessions — create a new Devin session
 */
router.post('/api/devin/sessions', async (req, res) => {
  try {
    const result = await createDevinSession({
      prompt: req.body.prompt || 'Fix the flaky integration tests',
      repository: req.body.repository || 'acme/payments-api',
      priority: req.body.priority || 'normal',
      playbook: req.body.playbook || 'default',
      notifyVia: req.body.notifyVia || 'slack',
      orgPlan: req.body.orgPlan || 'team',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SESSION_CREATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { executeWorkflow, WORKFLOWS, INTEGRATIONS, EVENTS } = require('../../services/verticals/threatly');

const router = express.Router();

/**
 * GET /api/threatly/workflows — returns workflows, integrations, and recent events
 */
router.get('/api/threatly/workflows', (_req, res) => {
  res.json({ workflows: WORKFLOWS, integrations: INTEGRATIONS, events: EVENTS });
});

/**
 * POST /api/threatly/execute — execute a security automation workflow
 */
router.post('/api/threatly/execute', async (req, res) => {
  try {
    const result = await executeWorkflow({
      workflowId: req.body.workflowId || 'WF-001',
      eventId: req.body.eventId || 'EVT-4401',
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
      code: error.code || 'WORKFLOW_EXECUTION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

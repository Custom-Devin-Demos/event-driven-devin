const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { getCockpit, getJob, runParallelValidation } = require('../../services/verticals/d21dc676');

const router = express.Router();

router.get('/api/d21dc676/cockpit', (req, res) => {
  res.json({ success: true, ...getCockpit() });
});

router.get('/api/d21dc676/jobs/:jobId', (req, res) => {
  try {
    res.json({ success: true, job: getJob(req.params.jobId) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

router.post('/api/d21dc676/parallel-run', verifySessionSecret, async (req, res) => {
  try {
    const result = await runParallelValidation({
      jobId: req.body.jobId,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PARALLEL_RUN_FAILED',
      agent: error.agent || null,
      details: error.details || null,
      steps: error.steps || [],
      requestId: req.requestId,
    });
  }
});

module.exports = router;

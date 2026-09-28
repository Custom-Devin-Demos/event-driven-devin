const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { getCockpit, resumeWave } = require('../../services/verticals/631ad31e');

const router = express.Router();

router.get('/api/631ad31e/cockpit', (req, res) => {
  res.json({ success: true, ...getCockpit() });
});

router.post('/api/631ad31e/resume-wave', verifySessionSecret, async (req, res) => {
  try {
    const result = await resumeWave({
      waveId: req.body.waveId,
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
      code: error.code || 'WAVE_RESUME_FAILED',
      agent: error.agent || null,
      steps: error.steps || [],
      requestId: req.requestId,
    });
  }
});

module.exports = router;

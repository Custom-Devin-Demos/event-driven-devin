const express = require('express');
const { getOverview, runRollout, resetRollout } = require('../../services/verticals/9663ef9a');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const router = express.Router();

router.get('/api/9663ef9a/overview', (_req, res) => res.json(getOverview()));
router.post('/api/9663ef9a/rollout', verifySessionSecret, async (req, res) => {
  try {
    res.json(await runRollout(req.body || {}));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message, errorType: error.name });
  }
});
router.post('/api/9663ef9a/rollout/reset', verifySessionSecret, (_req, res) => res.json(resetRollout()));

module.exports = router;

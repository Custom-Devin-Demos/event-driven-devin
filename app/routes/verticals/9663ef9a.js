const express = require('express');
const { getOverview, runSweep, resetSweep } = require('../../services/verticals/9663ef9a');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const router = express.Router();

router.get('/api/9663ef9a/overview', (_req, res) => res.json(getOverview()));
router.post('/api/9663ef9a/sweep', verifySessionSecret, async (req, res) => {
  try {
    res.json(await runSweep(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});
router.post('/api/9663ef9a/sweep/reset', verifySessionSecret, (_req, res) => res.json(resetSweep()));

module.exports = router;

const express = require('express');
const { runRebalance, resetRebalance, getOverview } = require('../../services/verticals/b539e9d4');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/b539e9d4/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/b539e9d4/rebalance', verifySessionSecret, async (req, res) => {
  try {
    const result = await runRebalance({
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
      synthetic: req.query.reports === 'off' || Boolean(req.get('x-synthetic')),
    });
    res.json({ ...result, overview: getOverview() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, errorType: error.name, overview: getOverview() });
  }
});

router.post('/api/b539e9d4/rebalance/reset', verifySessionSecret, (_req, res) => {
  res.json(resetRebalance());
});

module.exports = router;

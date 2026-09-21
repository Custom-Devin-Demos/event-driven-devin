const express = require('express');
const { runFaultSweep, resetFaultSweep, getOverview } = require('../../services/verticals/0eda990f');

const router = express.Router();

router.get('/api/0eda990f/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/0eda990f/fault-sweep/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runFaultSweep({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/0eda990f/fault-sweep/reset', (_req, res) => {
  res.json(resetFaultSweep());
});

module.exports = router;

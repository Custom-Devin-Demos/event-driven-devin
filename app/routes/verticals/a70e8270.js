const express = require('express');
const {
  runDailyLoad,
  resetLoad,
  getOverview,
  listRuns,
} = require('../../services/verticals/a70e8270');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/a70e8270/overview', (_req, res) => {
  res.json(getOverview());
});

router.get('/api/a70e8270/runs', (_req, res) => {
  res.json({ runs: listRuns() });
});

router.post('/api/a70e8270/load/run', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runDailyLoad({
      trigger: 'manual',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      errorType: error.name,
      sqlState: error.sqlState,
      code: error.code,
    });
  }
});

router.post('/api/a70e8270/load/reset', verifySessionSecret, (_req, res) => {
  res.json(resetLoad());
});

module.exports = router;

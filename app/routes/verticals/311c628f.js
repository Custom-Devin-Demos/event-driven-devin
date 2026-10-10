const express = require('express');
const {
  runNextWindow,
  retryPending,
  resetConsumer,
  getOverview,
  listWindows,
  listPending,
} = require('../../services/verticals/311c628f');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/311c628f/overview', (_req, res) => {
  res.json(getOverview());
});

router.get('/api/311c628f/windows', (_req, res) => {
  res.json({ windows: listWindows() });
});

router.get('/api/311c628f/pending', (_req, res) => {
  res.json({ pending: listPending() });
});

router.post('/api/311c628f/consumer/run', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runNextWindow({
      trigger: 'manual',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/311c628f/consumer/retry', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await retryPending({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/311c628f/consumer/reset', verifySessionSecret, (_req, res) => {
  res.json(resetConsumer());
});

module.exports = router;

const express = require('express');
const {
  runNextBatch,
  replayParked,
  resetIngest,
  getOverview,
  listRuns,
  listParked,
} = require('../../services/verticals/0a6f5e56');

const router = express.Router();

router.get('/api/0a6f5e56/overview', (_req, res) => {
  res.json(getOverview());
});

router.get('/api/0a6f5e56/runs', (_req, res) => {
  res.json({ runs: listRuns() });
});

router.get('/api/0a6f5e56/parked', (_req, res) => {
  res.json({ parked: listParked() });
});

router.post('/api/0a6f5e56/ingest/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runNextBatch({
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

router.post('/api/0a6f5e56/ingest/replay', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await replayParked({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/0a6f5e56/ingest/reset', (_req, res) => {
  res.json(resetIngest());
});

module.exports = router;

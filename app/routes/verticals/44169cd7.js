const express = require('express');
const { feedOverview, runSnapshot } = require('../../services/verticals/44169cd7');

const router = express.Router();

router.get('/api/44169cd7/feed', (_req, res) => {
  res.json(feedOverview());
});

router.post('/api/44169cd7/snapshots', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runSnapshot({
      runId: body.runId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SNAPSHOT_FAILED',
      snapshotId: error.snapshotId,
      requestId: req.requestId,
    });
  }
});

module.exports = router;

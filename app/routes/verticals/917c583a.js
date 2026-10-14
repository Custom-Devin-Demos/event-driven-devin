const express = require('express');
const { runCacheSyncCycle, resetCacheSync, getOverview } = require('../../services/verticals/917c583a');

const router = express.Router();

router.get('/api/917c583a/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/917c583a/cache-sync', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runCacheSyncCycle({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/917c583a/cache-sync/reset', (_req, res) => {
  res.json(resetCacheSync());
});

module.exports = router;

const express = require('express');
const { ingestUpload, resetIngest, getOverview } = require('../../services/verticals/3e5e338a');

const router = express.Router();

router.get('/api/3e5e338a/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/3e5e338a/results/upload', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ingestUpload({
      batchId: body.batchId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/3e5e338a/results/upload/reset', (_req, res) => {
  res.json(resetIngest());
});

module.exports = router;

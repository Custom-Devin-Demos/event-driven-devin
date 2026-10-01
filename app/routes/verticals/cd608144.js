const express = require('express');
const {
  processPendingBatch,
  resetPipeline,
  getOverview,
  listStudies,
} = require('../../services/verticals/cd608144');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/cd608144/overview', (_req, res) => {
  res.json(getOverview());
});

router.get('/api/cd608144/studies', (_req, res) => {
  res.json(listStudies());
});

router.post('/api/cd608144/process', verifySessionSecret, async (req, res) => {
  try {
    const result = await processPendingBatch({
      trigger: 'manual',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
    });
  }
});

router.post('/api/cd608144/process/reset', verifySessionSecret, (_req, res) => {
  res.json(resetPipeline());
});

module.exports = router;

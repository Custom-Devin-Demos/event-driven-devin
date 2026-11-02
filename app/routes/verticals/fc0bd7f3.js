const express = require('express');
const { ingestBatch, SITE_BATCHES, STUDY } = require('../../services/verticals/fc0bd7f3');

const router = express.Router();

router.get('/api/fc0bd7f3/context', (_req, res) => {
  res.json({ study: STUDY, sites: SITE_BATCHES });
});

router.post('/api/fc0bd7f3/ingest', async (req, res) => {
  try {
    res.json(await ingestBatch(req.body || {}));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.name === 'ValidationError' ? 'INVALID_REQUEST' : 'LAB_INGEST_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;

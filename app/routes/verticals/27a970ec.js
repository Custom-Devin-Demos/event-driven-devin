const express = require('express');
const { ingestBatch, SITE_BATCHES, STUDY } = require('../../services/verticals/27a970ec');

const router = express.Router();

router.get('/api/27a970ec/context', (_req, res) => {
  res.json({ study: STUDY, sites: SITE_BATCHES });
});

router.post('/api/27a970ec/ingest', async (req, res) => {
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

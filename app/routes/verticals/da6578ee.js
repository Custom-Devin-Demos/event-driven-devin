const express = require('express');
const {
  publishFeedBatch, runParityCheck, FEED_JOBS, FEED_CONTRACT,
} = require('../../services/verticals/da6578ee');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');

const router = express.Router();

router.get('/api/da6578ee/jobs', (_req, res) => {
  res.json({
    wave: FEED_CONTRACT.migrationWave,
    specVersion: FEED_CONTRACT.specVersion,
    targetTable: FEED_CONTRACT.targetTable,
    jobs: FEED_JOBS,
  });
});

router.get('/api/da6578ee/parity', (req, res) => {
  try {
    res.json(runParityCheck());
  } catch (error) {
    // Only reachable if the built contract is malformed. Parity reporting is the control
    // this migration is judged on, so its own failure goes to telemetry like every other
    // error path here rather than dying as a bare 500.
    logger.error('Feed parity check failed', {
      error: error.message,
      errorClass: error.name,
      service: 'mi-feed-migration',
      route: '/api/da6578ee/parity',
      requestId: req.requestId,
    });
    Sentry.captureException(error);

    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PARITY_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/da6578ee/publish', async (req, res) => {
  try {
    const result = await publishFeedBatch({
      jobId: req.body.jobId || 'CIQ-PX-EOD',
      asOfDate: req.body.asOfDate || new Date().toISOString().slice(0, 10),
      batch: req.body.batch,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PUBLISH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

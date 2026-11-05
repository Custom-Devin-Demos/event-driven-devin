const express = require('express');
const logger = require('../../telemetry/logger');
const { runRevocationBatch, resetRevocations, getOverview } = require('../../services/verticals/bceeea47');

const router = express.Router();

/** GET /api/bceeea47/overview — regions, connected systems, leaver queue, batch history and status. */
router.get('/api/bceeea47/overview', (_req, res) => {
  res.json(getOverview());
});

/** POST /api/bceeea47/revocations/run — run the leaver revocation batch over the current queue. */
router.post('/api/bceeea47/revocations/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runRevocationBatch({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    logger.error('Revocation batch request failed', { error: error.message, service: 'bceeea47-api' });
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
      status: getOverview().status,
    });
  }
});

/** POST /api/bceeea47/revocations/reset — presenter control: clear batch history and return to the opening state. */
router.post('/api/bceeea47/revocations/reset', (_req, res) => {
  const result = resetRevocations();
  res.status(result.success ? 200 : 409).json(result);
});

module.exports = router;

const express = require('express');
const path = require('path');
const logger = require('../../telemetry/logger');
const gate = require('../../services/verticals/eac595f3');

const router = express.Router();
const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', 'eac595f3.html');

router.get('/eac595f3', (_req, res) => {
  res.sendFile(PAGE);
});

router.get('/api/eac595f3/builds', (_req, res) => {
  res.json({ builds: gate.listBuilds(), integrations: gate.integrations() });
});

router.get('/api/eac595f3/audit', (_req, res) => {
  res.json({ audit: gate.getAudit() });
});

// Event: build submitted for release.
router.post('/api/eac595f3/submit', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await gate.submitBuild({
      buildId: body.buildId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      triggerDevin: Boolean(body.triggerDevin),
    });
    res.json(result);
  } catch (error) {
    logger.error('Release gate submit failed', { error: error.message, buildId: body.buildId });
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Demo: developer applies the correction the gate asked for.
router.post('/api/eac595f3/remediate', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await gate.remediateBuild(body.buildId));
  } catch (error) {
    logger.error('Release gate remediate failed', { error: error.message, buildId: body.buildId });
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/api/eac595f3/reset', async (_req, res) => {
  res.json({ ok: true, ...(await gate.resetDemo()) });
});

module.exports = router;

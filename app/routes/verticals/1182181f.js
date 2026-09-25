const express = require('express');
const {
  getPlant,
  getLine,
  getLineManifest,
  listRuns,
  runAllLines,
  runPipeline,
  acknowledgeAlarm,
  startScheduler,
} = require('../../services/verticals/1182181f');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Only the hub-selected identity fields cross from the request body into the
// pipeline; nothing else the caller sends reaches the alert/session payload.
function identityFrom(body) {
  return {
    devinUserId: text(body.devinUserId, 128) || undefined,
    devinOrgId: text(body.devinOrgId, 128) || undefined,
    devinEmail: text(body.devinEmail, 254) || undefined,
  };
}

router.get('/api/1182181f/plant', (_req, res) => {
  res.json(getPlant());
});

router.get('/api/1182181f/runs', (req, res) => {
  res.json({ runs: listRuns({ limit: req.query.limit, lineCode: req.query.line }) });
});

router.get('/api/1182181f/lines/:code', (req, res) => {
  const result = getLine(req.params.code);
  if (!result) return res.status(404).json({ error: 'Line not found' });
  return res.json(result);
});

router.post('/api/1182181f/alarms/:id/ack', verifySessionSecret, (req, res) => {
  const alarm = acknowledgeAlarm(req.params.id, text((req.body || {}).user, 64));
  if (!alarm) return res.status(404).json({ error: 'Alarm not found' });
  return res.json({ alarm });
});

router.post('/api/1182181f/runs', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  const lineCode = text(body.lineCode, 16) || 'all';
  const meta = { ...identityFrom(body), trigger: 'manual' };
  try {
    if (lineCode !== 'all' && !getLineManifest(lineCode)) {
      return res.status(400).json({ error: 'Unknown line' });
    }
    const runs = lineCode === 'all'
      ? await runAllLines(meta)
      : [await runPipeline(lineCode, meta)];
    return res.status(200).json({ runs, plant: getPlant() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (process.env.NODE_ENV !== 'test' && process.env.X1182181F_SCHEDULER_ENABLED === 'true') startScheduler();

module.exports = router;

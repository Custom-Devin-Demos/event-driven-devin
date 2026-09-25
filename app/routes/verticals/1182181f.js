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

const router = express.Router();

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

router.post('/api/1182181f/alarms/:id/ack', (req, res) => {
  const alarm = acknowledgeAlarm(req.params.id, (req.body || {}).user);
  if (!alarm) return res.status(404).json({ error: 'Alarm not found' });
  return res.json({ alarm });
});

router.post('/api/1182181f/runs', async (req, res) => {
  const body = req.body || {};
  const lineCode = body.lineCode || 'all';
  try {
    if (lineCode !== 'all' && !getLineManifest(lineCode)) {
      return res.status(400).json({ error: 'Unknown line' });
    }
    const runs = lineCode === 'all'
      ? await runAllLines({ ...body, trigger: 'manual' })
      : [await runPipeline(lineCode, { ...body, trigger: 'manual' })];
    return res.status(200).json({ runs, plant: getPlant() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (process.env.NODE_ENV !== 'test' && process.env.X1182181F_SCHEDULER_ENABLED === 'true') startScheduler();

module.exports = router;

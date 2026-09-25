const express = require('express');
const {
  getFleet,
  getAsset,
  getGatewayManifest,
  listRuns,
  runAllGateways,
  runPipeline,
  acknowledgeEvent,
  startScheduler,
} = require('../../services/verticals/26af2083');

const router = express.Router();

router.get('/api/26af2083/fleet', (_req, res) => {
  res.json(getFleet());
});

router.get('/api/26af2083/runs', (req, res) => {
  res.json({ runs: listRuns({ limit: req.query.limit, gateway: req.query.gateway }) });
});

router.get('/api/26af2083/assets/:id', (req, res) => {
  const result = getAsset(req.params.id);
  if (!result) return res.status(404).json({ error: 'Asset not found' });
  return res.json(result);
});

router.post('/api/26af2083/events/:id/ack', (req, res) => {
  const event = acknowledgeEvent(req.params.id, (req.body || {}).user);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  return res.json({ event });
});

router.post('/api/26af2083/runs', async (req, res) => {
  const body = req.body || {};
  const gateway = body.gateway || 'all';
  try {
    if (gateway !== 'all' && !getGatewayManifest(gateway)) {
      return res.status(400).json({ error: 'Unknown gateway' });
    }
    const runs = gateway === 'all'
      ? await runAllGateways({ ...body, trigger: 'manual' })
      : [await runPipeline(gateway, { ...body, trigger: 'manual' })];
    return res.status(200).json({ runs, fleet: getFleet() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (
  process.env.NODE_ENV !== 'test'
  && process.env.X26AF2083_SCHEDULER_ENABLED === 'true'
) startScheduler();

module.exports = router;

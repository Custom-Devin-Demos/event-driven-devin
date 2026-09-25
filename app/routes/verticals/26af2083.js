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

router.post('/api/26af2083/events/:id/ack', verifySessionSecret, (req, res) => {
  const event = acknowledgeEvent(req.params.id, text((req.body || {}).user, 64));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  return res.json({ event });
});

router.post('/api/26af2083/runs', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  const gateway = text(body.gateway, 16) || 'all';
  const meta = { ...identityFrom(body), trigger: 'manual' };
  try {
    if (gateway !== 'all' && !getGatewayManifest(gateway)) {
      return res.status(400).json({ error: 'Unknown gateway' });
    }
    const runs = gateway === 'all'
      ? await runAllGateways(meta)
      : [await runPipeline(gateway, meta)];
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

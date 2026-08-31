const express = require('express');
const path = require('path');
const logger = require('../telemetry/logger');
const engine = require('../services/incident-lab/engine');
const { createDatadogSink } = require('../services/incident-lab/datadog-emitter');
const { createSlackPersonaSink } = require('../services/incident-lab/personas');

/**
 * Incident Lab presenter surface (unlisted): arm and declare an evolving
 * incident scenario. The engine drives real Datadog telemetry and the
 * Datadog Incidents API declaration; Datadog's Slack integration creates
 * the incident channel, the incident responder auto-joins it by prefix,
 * and the persona layer runs the scripted timeline inside it.
 *
 * Mutations require INCIDENT_LAB_TOKEN (X-Lab-Token header) — a run
 * creates real Datadog incidents and Slack traffic.
 */

engine.registerSink(createDatadogSink());
engine.registerSink(createSlackPersonaSink());

const router = express.Router();

function requireLabToken(req, res, next) {
  const expected = process.env.INCIDENT_LAB_TOKEN;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'INCIDENT_LAB_TOKEN is not configured' });
  }
  if (req.get('X-Lab-Token') !== expected) {
    logger.warn('Incident Lab: bad lab token', { path: req.path });
    return res.status(403).json({ ok: false, error: 'Invalid lab token' });
  }
  return next();
}

router.get('/oncall/incident-lab', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'incident-lab.html'));
});

router.get('/api/incident-lab/status', (_req, res) => {
  res.json({ ok: true, ...engine.status() });
});

router.post('/api/incident-lab/arm', requireLabToken, async (req, res) => {
  const result = await engine.arm((req.body || {}).scenario);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/declare', requireLabToken, async (_req, res) => {
  const result = await engine.declare();
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/phase', requireLabToken, async (req, res) => {
  const result = await engine.triggerPhase((req.body || {}).phase);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/stop', requireLabToken, async (_req, res) => {
  const result = await engine.stop('stopped via control page');
  res.status(result.ok ? 200 : 400).json(result);
});

module.exports = router;

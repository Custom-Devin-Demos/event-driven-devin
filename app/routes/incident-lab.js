const express = require('express');
const path = require('path');
const logger = require('../telemetry/logger');
const engine = require('../services/incident-lab/engine');
const { createDatadogSink } = require('../services/incident-lab/datadog-emitter');
const { createSlackPersonaSink } = require('../services/incident-lab/personas');
const { createSupabaseSeedSink } = require('../services/incident-lab/supabase-seed');

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

// Seeding first: the warehouse rows a scenario points an investigator at
// are timestamped relative to the arm, so they are refreshed before any
// telemetry starts flowing.
engine.registerSink(createSupabaseSeedSink());
engine.registerSink(createDatadogSink());
engine.registerSink(createSlackPersonaSink());

// A run suspended by a restart/deploy resumes where it left off — armed
// baseline noise restarts and a declared run's remaining timeline picks
// back up against the original clock.
Promise.resolve()
  .then(() => engine.resume())
  .then((result) => {
    if (result.ok) {
      logger.info('Incident Lab run resumed after restart', { runRef: result.runRef, status: result.status });
    }
  })
  .catch((error) => logger.warn('Incident Lab resume failed', { error: error.message }));

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

// Real Datadog/Slack traffic rides on every mutation: throttle them so a
// scripted or runaway client cannot burn external quotas mid-demo.
let mutationTimestamps = [];
function throttleMutations(_req, res, next) {
  const windowMs = Number(process.env.INCIDENT_LAB_MUTATION_WINDOW_MS) || 60000;
  const limit = Number(process.env.INCIDENT_LAB_MUTATION_LIMIT) || 20;
  const now = Date.now();
  mutationTimestamps = mutationTimestamps.filter((t) => now - t < windowMs);
  if (mutationTimestamps.length >= limit) {
    return res.status(429).json({ ok: false, error: 'Too many control requests — try again shortly' });
  }
  mutationTimestamps.push(now);
  return next();
}

router.get('/oncall/incident-lab', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'incident-lab.html'));
});

// Run details (run refs, incident ids, phases, log) are presenter-only:
// without a valid lab token the status is reduced to the scenario catalog
// and coarse state so outsiders cannot watch an exercise in real time.
router.get('/api/incident-lab/status', (req, res) => {
  const full = engine.status();
  const expected = process.env.INCIDENT_LAB_TOKEN;
  if (expected && req.get('X-Lab-Token') === expected) {
    return res.json({ ok: true, ...full });
  }
  return res.json({ ok: true, status: full.status, scenarios: full.scenarios });
});

router.post('/api/incident-lab/arm', requireLabToken, throttleMutations, async (req, res) => {
  const result = await engine.arm((req.body || {}).scenario);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/declare', requireLabToken, throttleMutations, async (_req, res) => {
  const result = await engine.declare();
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/phase', requireLabToken, throttleMutations, async (req, res) => {
  const result = await engine.triggerPhase((req.body || {}).phase);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/api/incident-lab/stop', requireLabToken, throttleMutations, async (_req, res) => {
  const result = await engine.stop('stopped via control page');
  res.status(result.ok ? 200 : 400).json(result);
});

module.exports = router;

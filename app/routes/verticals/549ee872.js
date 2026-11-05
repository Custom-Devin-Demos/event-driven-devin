const express = require('express');
const logger = require('../../telemetry/logger');
const { startApplication } = require('../../services/verticals/549ee872');
const { OFFERINGS } = require('../../services/verticals/549ee872-catalog');

const router = express.Router();

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 50;
const hits = new Map();

function underCap(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(ip, recent); return false; }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

router.get('/api/549ee872/offerings', (req, res) => {
  res.json({ offerings: OFFERINGS.map(({ code, name, family }) => ({ code, name, family })) });
});

router.post('/api/549ee872/applications', async (req, res) => {
  if (!underCap(req.ip)) {
    logger.warn('Homepage application rate cap reached', { ip: req.ip, route: req.path });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const application = await startApplication({
      selection: typeof body.selection === 'string' ? body.selection.slice(0, 40) : '',
      entryPoint: typeof body.entryPoint === 'string' ? body.entryPoint.slice(0, 80) : '',
      funding: body.funding,
      report: body.report,
      devinUserId: typeof body.devinUserId === 'string' ? body.devinUserId.slice(0, 120) : '',
      devinOrgId: typeof body.devinOrgId === 'string' ? body.devinOrgId.slice(0, 120) : '',
      devinEmail: typeof body.devinEmail === 'string' ? body.devinEmail.slice(0, 120) : '',
    });
    return res.json({ ok: true, application });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'We can\u2019t open your account right now.',
      message: error.message,
      requestId: error.requestId,
    });
  }
});

module.exports = router;

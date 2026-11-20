const express = require('express');
const logger = require('../../telemetry/logger');
const { submitEnquiry } = require('../../services/verticals/228d0473');

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

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

router.post('/api/228d0473/enquiries', async (req, res) => {
  if (!underCap(req.ip)) {
    logger.warn('Masterpiece enquiry rate cap reached', { ip: req.ip, route: req.path });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const enquiry = await submitEnquiry({
      entryPoint: str(body.entryPoint, 80),
      market: str(body.market, 4),
      report: body.report,
      devinUserId: str(body.devinUserId, 120),
      devinOrgId: str(body.devinOrgId, 120),
      devinEmail: str(body.devinEmail, 120),
    });
    return res.json({ ok: true, enquiry });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'Sorry, we couldn’t submit your enquiry.',
      message: error.message,
      requestId: error.requestId,
    });
  }
});

module.exports = router;

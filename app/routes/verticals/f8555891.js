const express = require('express');
const { releaseBatch, submitSupportTicket, BATCH, getBatchCompanies } = require('../../services/verticals/f8555891');

const router = express.Router();

router.get('/api/f8555891/batch', (_req, res) => {
  res.json({ batch: BATCH, companies: getBatchCompanies() });
});

router.post('/api/f8555891/release-batch', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await releaseBatch({
      batchId: body.batchId || 'PB-2026-09-15-A',
      companyIds: body.companyIds,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'BATCH_RELEASE_FAILED',
      requestId: req.requestId,
    });
  }
});

// Each report fans out to up to six Slack posts, so cap reports per client
// per hour (same shape as the on-call bug route's hourly cap).
const TICKET_CAP_PER_HOUR = 10;
const TICKET_CAP_WINDOW_MS = 60 * 60 * 1000;
const ticketWindows = new Map();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function ticketCap(req, res, next) {
  const now = Date.now();
  const cutoff = now - TICKET_CAP_WINDOW_MS;
  const key = clientIp(req);
  const window = (ticketWindows.get(key) || []).filter((ts) => ts > cutoff);
  if (window.length >= TICKET_CAP_PER_HOUR) {
    res.set('Retry-After', String(Math.max(Math.ceil((window[0] + TICKET_CAP_WINDOW_MS - now) / 1000), 1)));
    return res.status(429).json({
      ok: false,
      error: `Hourly limit reached for support tickets (${TICKET_CAP_PER_HOUR}/hour). Try again later.`,
      code: 'RATE_LIMITED',
    });
  }
  window.push(now);
  ticketWindows.set(key, window);
  for (const [otherKey, otherWindow] of ticketWindows) {
    if (otherKey !== key && otherWindow.every((ts) => ts <= cutoff)) ticketWindows.delete(otherKey);
  }
  return next();
}

router.post('/api/f8555891/support-ticket', ticketCap, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await submitSupportTicket({
      subject: body.subject,
      text: body.text,
      reporter: body.reporter,
      severity: body.severity,
      productArea: body.productArea,
      split: Boolean(body.split),
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SUPPORT_TICKET_FAILED',
      requestId: req.requestId,
      ...(error.tickets ? { tickets: error.tickets, ticketCount: error.ticketCount } : {}),
    });
  }
});

module.exports = router;

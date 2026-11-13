const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { ERROR_PATH, validReport, reportFailure } = require('../../services/verticals/nourish-mobile');

function createRouter({ now = Date.now, perClient = 10, globalMax = 100, windowMs = 600000 } = {}) {
  const router = express.Router();
  const clients = new Map();
  const reports = new Map();
  let global = { start: now(), count: 0 };

  function limit(req, res, next) {
    const time = now();
    if (time - global.start >= windowMs) global = { start: time, count: 0 };
    for (const [ip, slot] of clients) {
      if (time - slot.start >= windowMs) clients.delete(ip);
    }
    // nginx appends the real client address; match the on-call limiter.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' && forwarded.trim()
      ? forwarded.split(',').pop().trim()
      : (req.socket.remoteAddress || 'unknown');
    const client = clients.get(ip) || { start: time, count: 0 };
    global.count += 1;
    client.count += 1;
    const full = !clients.has(ip) && clients.size >= 1000;
    if (!full) clients.set(ip, client);
    if (full || global.count > globalMax || client.count > perClient) {
      return res.set('Retry-After', String(Math.ceil(windowMs / 1000)))
        .status(429).json({ accepted: false });
    }
    next();
  }

  router.post(ERROR_PATH, limit, express.json({ limit: '2kb' }), (req, res) => {
    if (!validReport(req.body)) return res.status(400).json({ accepted: false });
    const time = now();
    for (const [key, report] of reports) {
      if (time - report.created >= windowMs) reports.delete(key);
    }
    const suppressed = Object.hasOwn(req.headers, 'x-synthetic')
      || req.headers['x-oncall-mode'] === '1' || req.query.reports === 'off'
      || process.env.NOURISH_REPORTS_DISABLED === '1';
    // Three allowed platforms, each with separate suppressed and live state.
    const key = `${suppressed}:${req.body.platform}`;
    const existing = reports.get(key);
    if (existing) return res.status(202).json({ accepted: true, reportId: existing.reportId, duplicate: true });
    const reportId = uuidv4();
    reports.set(key, { reportId, created: time });
    if (!suppressed) reportFailure(req.body.platform, reportId);
    return res.status(202).json({ accepted: true, reportId, duplicate: false });
  });
  router.use(ERROR_PATH, (error, _req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ accepted: false });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ accepted: false });
    return next(error);
  });
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;

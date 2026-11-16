const crypto = require('crypto');
const express = require('express');
const logger = require('../telemetry/logger');

module.exports = function batchSettlementRouter(service, cap) {
  const router = express.Router();
  router.post('/runs', cap, (req, res) => {
    const result = service.start(req.body);
    res.status(result.status).json(result.body);
  });
  router.post('/reset', cap, (_req, res) => res.json(service.reset()));
  router.get('/state', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await service.state()); }
    catch { res.status(502).json({ error: 'PagerDuty state unavailable; verify token and connectivity' }); }
  });
  router.post('/pagerduty-webhook', async (req, res) => {
    const expected = Buffer.from(process.env.BATCH_PD_WEBHOOK_SECRET || '');
    const supplied = Buffer.from(req.get('X-Webhook-Secret') || '');
    if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    try {
      const result = await service.webhook(req.body);
      return res.status(result.status).json(result.body);
    } catch {
      logger.error('Batch settlement webhook lookup failed');
      return res.status(503).json({ error: 'PagerDuty lookup unavailable; retry delivery' });
    }
  });
  return router;
};

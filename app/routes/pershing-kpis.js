const express = require('express');
const path = require('path');
const kpis = require('../services/pershing-kpis');
const logger = require('../telemetry/logger');
const { Sentry } = require('../telemetry/sentry');
const { verifySessionSecret } = require('../middleware/verify-session-secret');

const router = express.Router();
const PAGE = path.join(__dirname, '..', 'public', 'pershing-kpis.html');

router.get(['/pershing-kpis', '/bny-kpis'], (_req, res) => res.sendFile(PAGE));

router.get('/api/pershing-kpis/state', (_req, res) => res.json(kpis.getState()));

router.get('/api/pershing-kpis/preview/:date', (req, res) => {
  try {
    const { text, analysis } = kpis.renderDay(req.params.date);
    res.json({ text, drop: analysis.isDrop, newDrop: analysis.isNewDrop, dropPts: analysis.dropPts });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const run = (fn) => async (req, res) => {
  try {
    res.json(await fn(req.body || {}));
  } catch (err) {
    logger.warn('Pershing KPI run failed', { error: err.message });
    if (!err.status || err.status >= 500) {
      Sentry.captureException(err, { tags: { feature: 'pershing-kpis', route: req.path } });
    }
    res.status(err.status || 502).json({ error: err.message });
  }
};

router.post('/api/pershing-kpis/seed', verifySessionSecret, run((body) => kpis.seed({ from: body.from, to: body.to })));
router.post('/api/pershing-kpis/next-day', verifySessionSecret, run((body) => kpis.nextDay({ date: body.date })));
router.post('/api/pershing-kpis/clear', verifySessionSecret, run(() => kpis.clearChannel()));
router.post('/api/pershing-kpis/reset', verifySessionSecret, run(async () => { kpis.resetState(); return kpis.getState(); }));

module.exports = router;

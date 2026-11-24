const express = require('express');
const path = require('path');
const { submitDemoRequest, PREFILL, OPTIONS, LATENCY_SLO } = require('../../services/verticals/02549888');

const router = express.Router();
const demoPage = path.join(__dirname, '../../public/verticals/02549888-assets/see-a-demo.html');

router.get(['/healthie/see-a-demo', '/02549888/see-a-demo'], (_req, res) => res.sendFile(demoPage));

router.get('/api/02549888/config', (_req, res) => {
  res.json({ success: true, prefill: PREFILL, options: OPTIONS, budgetMs: LATENCY_SLO.budgetMs });
});

router.post('/api/02549888/demo-requests', async (req, res, next) => {
  try {
    const rehearsal = req.query.reports === 'off'
      || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');
    res.json(await submitDemoRequest(req.body || {}, { rehearsal }));
  } catch (error) {
    if (error.statusCode !== 400) return next(error);
    return res.status(400).json({ success: false, error: error.message, code: 'INVALID_DEMO_REQUEST' });
  }
});

module.exports = router;

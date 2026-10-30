const express = require('express');
const logger = require('../../telemetry/logger');
const { startQuote } = require('../../services/verticals/957da0c9');
const { PRODUCT_CATALOG } = require('../../services/verticals/957da0c9-products');

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

router.get('/api/957da0c9/products', (req, res) => {
  res.json({ products: PRODUCT_CATALOG.map(({ code, name }) => ({ code, name })) });
});

router.post('/api/957da0c9/quotes', async (req, res) => {
  if (!underCap(req.ip)) {
    logger.warn('Homepage quote rate cap reached', { ip: req.ip, route: req.path });
    return res.status(429).json({ error: 'Too many quote requests. Please try again later.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const quote = await startQuote({
      selection: typeof body.selection === 'string' ? body.selection.slice(0, 40) : '',
      entryPoint: typeof body.entryPoint === 'string' ? body.entryPoint.slice(0, 80) : '',
      applicant: body.applicant,
      report: body.report,
      devinUserId: typeof body.devinUserId === 'string' ? body.devinUserId.slice(0, 120) : '',
      devinOrgId: typeof body.devinOrgId === 'string' ? body.devinOrgId.slice(0, 120) : '',
      devinEmail: typeof body.devinEmail === 'string' ? body.devinEmail.slice(0, 120) : '',
    });
    return res.json({ ok: true, quote });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'We can\u2019t start your quote right now.',
      message: error.message,
      requestId: error.requestId,
    });
  }
});

module.exports = router;

const express = require('express');
const { processOfferInquiry, OFFERS } = require('../../services/verticals/e1aeb83c');

const router = express.Router();

// Sliding-window limiter for the public inquiry endpoint.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

function reserveSlot(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

router.get('/api/e1aeb83c/offers', (_req, res) => {
  res.json({
    offers: Object.values(OFFERS).map((o) => ({ id: o.id, name: o.name, titles: o.titles })),
  });
});

router.post('/api/e1aeb83c/inquiry', async (req, res) => {
  const key = req.ip || 'unknown';
  if (!reserveSlot(key)) {
    res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED', requestId: req.requestId });
    return;
  }

  try {
    const result = await processOfferInquiry({
      offer: req.body.offer || 'wsj-digital',
      billing: req.body.billing || 'annual',
      action: req.body.action || 'subscribe',
      trackingCode: req.body.trackingCode,
      region: req.body.region,
      reportErrors: req.body.reportErrors,
      viewerUserId: req.body.devinUserId,
      viewerOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'OFFER_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

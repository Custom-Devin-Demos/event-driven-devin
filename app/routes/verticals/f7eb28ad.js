const express = require('express');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const { createOrder } = require('../../services/verticals/f7eb28ad');

const router = express.Router();

/**
 * unity.com serves its Nohemi display face without CORS headers, so the page
 * loads it through this same-origin pass-through. Only the listed file is
 * allowed; anything else is a 404.
 */
const FONT_CDN = 'https://unity.com/_next/static/media';
const FONT_FILES = {
  'nohemi-medium.woff2': 'Nohemi_Medium-s.p.0jvhrdoe3l7zp.woff2',
};
const fontCache = new Map();

router.get('/api/f7eb28ad/fonts/:file', async (req, res) => {
  const upstreamFile = FONT_FILES[req.params.file];
  if (!upstreamFile) {
    res.status(404).end();
    return;
  }
  try {
    let body = fontCache.get(upstreamFile);
    if (!body) {
      const upstream = await axios.get(`${FONT_CDN}/${upstreamFile}`, { responseType: 'arraybuffer', timeout: 20000 });
      body = Buffer.from(upstream.data);
      fontCache.set(upstreamFile, body);
    }
    res.set('Content-Type', 'font/woff2');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.send(body);
  } catch (error) {
    logger.warn('Unity font pass-through failed; page falls back to Inter', { file: req.params.file, error: error.message });
    res.status(502).end();
  }
});

/**
 * POST /api/f7eb28ad/order/create — Unity Store checkout for Unity Pro seats
 */
router.post('/api/f7eb28ad/order/create', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await createOrder({
      product: body.product || 'UTY-EDITION-PRO',
      variant: body.variant || 'unity-pro-1-year-monthly',
      seats: body.seats ?? 1,
      organization: body.organization,
      email: body.email,
      country: body.country || 'US',
      termsAccepted: body.termsAccepted,
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
      code: error.code || 'ORDER_CREATE_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

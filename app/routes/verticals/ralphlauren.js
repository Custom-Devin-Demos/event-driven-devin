const express = require('express');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const {
  placeOrder, CATALOG, FITS, FIT_SIZE_RUNS, SHIPPING_METHODS, STATE_TAX,
} = require('../../services/verticals/ralphlauren');

const router = express.Router();

/**
 * ralphlauren.com serves its web fonts without CORS headers, so the page
 * loads them through this same-origin pass-through. Only the families the
 * page uses are allowed; anything else is a 404.
 */
const FONT_CDN = 'https://www.ralphlauren.com/on/demandware.static/-/Library-Sites-RalphLauren_NA_Library/en_US/v1791799041582/_common/fonts/df-refresh/Fonts';
const FONT_FILES = new Set([
  'FoundersGroteskTextWeb-Regular.woff2',
  'FoundersGroteskTextWeb-Medium.woff2',
  'FoundersGroteskMonoWeb-Regular.woff2',
  'FoundersGroteskMonoWeb-Medium.woff2',
  'LeJeuneDeck-Regular-Web.woff2',
  'LeJeuneDeck-Light-Web.woff2',
]);
const fontCache = new Map();

router.get('/api/ralphlauren/fonts/:file', async (req, res) => {
  const { file } = req.params;
  if (!FONT_FILES.has(file)) {
    res.status(404).end();
    return;
  }
  try {
    let body = fontCache.get(file);
    if (!body) {
      const upstream = await axios.get(`${FONT_CDN}/${file}`, { responseType: 'arraybuffer', timeout: 8000 });
      body = Buffer.from(upstream.data);
      fontCache.set(file, body);
    }
    res.set('Content-Type', 'font/woff2');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.send(body);
  } catch (error) {
    logger.warn('Ralph Lauren font pass-through failed; page falls back to system fonts', { file, error: error.message });
    res.status(502).end();
  }
});

/**
 * GET /api/ralphlauren/catalog — polo shirts, fits, size runs, shipping and tax options
 */
router.get('/api/ralphlauren/catalog', (_req, res) => {
  res.json({
    products: CATALOG,
    fits: Object.values(FITS),
    sizeRuns: FIT_SIZE_RUNS,
    shipping: Object.values(SHIPPING_METHODS),
    states: Object.entries(STATE_TAX).map(([code, rule]) => ({ code, label: rule.label })),
  });
});

/**
 * POST /api/ralphlauren/checkout — place the bag as an order
 */
router.post('/api/ralphlauren/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      shippingMethod: body.shippingMethod || 'standard',
      state: body.state || 'NY',
      rlAccount: body.rlAccount !== false,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(order);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

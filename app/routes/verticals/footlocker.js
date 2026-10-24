const express = require('express');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const {
  placeOrder, CATALOG, GROUPS, SIZE_SCALES, SHIPPING_METHODS, STATE_TAX, MAX_BAG_LINES, MAX_LINE_QTY,
} = require('../../services/verticals/footlocker');

const router = express.Router();

/**
 * footlocker.com serves its web fonts without CORS headers, so the page
 * loads them through this same-origin pass-through. Only the families the
 * page uses are allowed; anything else is a 404.
 */
const FONT_CDN = 'https://www.footlocker.com/fonts';
const FONT_FILES = new Map([
  ['MavenPro-Regular.woff2', 'font/woff2'],
  ['MavenPro-Medium.woff2', 'font/woff2'],
  ['MavenPro-SemiBold.woff2', 'font/woff2'],
  ['MavenPro-ExtraBold.woff2', 'font/woff2'],
  ['FootLocker-FLClassic.woff', 'font/woff'],
]);
const fontCache = new Map();

router.get('/api/footlocker/fonts/:file', async (req, res) => {
  const { file } = req.params;
  const contentType = FONT_FILES.get(file);
  if (!contentType) {
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
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.send(body);
  } catch (error) {
    logger.warn('Foot Locker font pass-through failed; page falls back to system fonts', { file, error: error.message });
    res.status(502).end();
  }
});

/**
 * GET /api/footlocker/catalog — new arrivals, groups, size scales, shipping and tax options
 */
router.get('/api/footlocker/catalog', (_req, res) => {
  res.json({
    products: CATALOG,
    groups: Object.values(GROUPS),
    sizeScales: SIZE_SCALES,
    shipping: Object.values(SHIPPING_METHODS),
    states: Object.entries(STATE_TAX).map(([code, rule]) => ({ code, label: rule.label })),
    maxBagLines: MAX_BAG_LINES,
    maxLineQty: MAX_LINE_QTY,
  });
});

/**
 * POST /api/footlocker/checkout — place the bag as an order
 */
router.post('/api/footlocker/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      shippingMethod: body.shippingMethod || 'standard',
      state: body.state || 'NY',
      flxMember: body.flxMember !== false,
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

const express = require('express');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const {
  placeOrder, CATALOG, SHELVES, CATEGORIES, OFFERS, BRANDS,
  DELIVERY_FEE, SERVICE_FEE_RATE, TAX_RATE, SMALL_BASKET_MIN, SMALL_BASKET_FEE, MAX_LINE_QTY, MAX_CART_LINES,
} = require('../../services/verticals/7eleven');

const router = express.Router();

/**
 * 7-eleven.com serves the 7NOW web fonts without CORS headers, so the page
 * loads them through this same-origin pass-through. Only the families the
 * page uses are allowed; anything else is a 404.
 */
const FONT_CDN = 'https://www.7-eleven.com/7now/_next/static/media';
const FONT_FILES = new Map([
  ['Basis Grotesque Pro Regular.fef1d0ac.woff2', 'font/woff2'],
  ['Basis Grotesque Pro Medium.3445d153.woff2', 'font/woff2'],
  ['Basis Grotesque Pro Bold.13317b53.woff2', 'font/woff2'],
]);
const fontCache = new Map();

router.get('/api/7eleven/fonts/:file', async (req, res) => {
  const { file } = req.params;
  const contentType = FONT_FILES.get(file);
  if (!contentType) {
    res.status(404).end();
    return;
  }
  try {
    let body = fontCache.get(file);
    if (!body) {
      const upstream = await axios.get(`${FONT_CDN}/${encodeURIComponent(file)}`, { responseType: 'arraybuffer', timeout: 8000 });
      body = Buffer.from(upstream.data);
      fontCache.set(file, body);
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.send(body);
  } catch (error) {
    logger.warn('7NOW font pass-through failed; page falls back to system fonts', { file, error: error.message });
    res.status(502).end();
  }
});

/**
 * GET /api/7eleven/catalog — home page shelves, categories, offers, brands and fee schedule
 */
router.get('/api/7eleven/catalog', (_req, res) => {
  res.json({
    products: CATALOG,
    shelves: SHELVES,
    categories: CATEGORIES,
    offers: OFFERS,
    brands: BRANDS,
    fees: {
      deliveryFee: DELIVERY_FEE,
      serviceFeeRate: SERVICE_FEE_RATE,
      taxRate: TAX_RATE,
      smallBasketMin: SMALL_BASKET_MIN,
      smallBasketFee: SMALL_BASKET_FEE,
    },
    maxLineQty: MAX_LINE_QTY,
    maxCartLines: MAX_CART_LINES,
  });
});

/**
 * POST /api/7eleven/checkout — place the cart as a delivery order
 */
router.post('/api/7eleven/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    const order = await placeOrder({
      items: body.items,
      address: body.address,
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

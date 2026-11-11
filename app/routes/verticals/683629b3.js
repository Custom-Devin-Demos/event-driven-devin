const express = require('express');
const path = require('path');
const {
  API_BASE,
  ROUTE,
  FEEDBACK_ROUTE,
  APP_WEB_PATH,
  SERVICE,
  PRODUCTS,
  MEMORY_OPTIONS,
  STORAGE_OPTIONS,
  DEMO_ACCOUNT,
  quoteItem,
  quoteCart,
  placeOrder,
  refreshOrderStatus,
  submitFeedback,
  publicConfig,
} = require('../../services/verticals/683629b3');

const router = express.Router();

// Hosted `vite build --base=/683629b3/app/` output of the Dell.com storefront
// (github.com/COG-GTM/dell-com-demo).
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '683629b3-app');

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});

// Friendly entry points (there is no <slug>.html page for this vertical).
for (const entry of ['/683629b3', '/dell-com', '/dellcom', '/dell-store', '/dell-storefront']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

router.use(API_BASE, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function sendError(res, req, error, fallbackCode) {
  const status = error.statusCode || 500;
  res.status(status).json({
    success: false,
    error: error.publicMessage || (status < 500 ? error.message : 'Something went wrong. Please try again.'),
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get(`${API_BASE}/health`, (_req, res) => res.json({ ok: true, service: SERVICE }));

router.get(`${API_BASE}/catalog`, (_req, res) => {
  res.json({ products: PRODUCTS, memoryOptions: MEMORY_OPTIONS, storageOptions: STORAGE_OPTIONS });
});

router.get(`${API_BASE}/account`, (_req, res) => res.json(DEMO_ACCOUNT));

router.post(`${API_BASE}/account/orders/:orderId/status`, (req, res) => {
  try {
    res.json(refreshOrderStatus(req.params.orderId));
  } catch (error) {
    sendError(res, req, error, 'ORDER_STATUS_FAILED');
  }
});

router.get(`${API_BASE}/config`, (_req, res) => res.json(publicConfig()));

router.post(`${API_BASE}/quotes`, (req, res) => {
  try {
    res.json(quoteItem(req.body));
  } catch (error) {
    sendError(res, req, error, 'QUOTE_FAILED');
  }
});

router.post(`${API_BASE}/cart/quote`, (req, res) => {
  try {
    res.json(quoteCart(req.body && req.body.items));
  } catch (error) {
    sendError(res, req, error, 'QUOTE_FAILED');
  }
});

router.post(ROUTE, async (req, res) => {
  try {
    res.status(201).json(await placeOrder(req.body));
  } catch (error) {
    sendError(res, req, error, 'CHECKOUT_FAILED');
  }
});

router.post(FEEDBACK_ROUTE, async (req, res) => {
  try {
    const result = await submitFeedback(req.body);
    res.status(result.status === 'sent' ? 201 : 202).json(result);
  } catch (error) {
    sendError(res, req, error, 'FEEDBACK_FAILED');
  }
});

router.all(`${API_BASE}/{*splat}`, (_req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found.', code: 'NOT_FOUND' });
});

module.exports = router;

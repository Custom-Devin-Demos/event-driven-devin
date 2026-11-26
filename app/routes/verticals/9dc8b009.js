const express = require('express');
const { getCatalog, placeOrder, getOrder } = require('../../services/verticals/9dc8b009');

const router = express.Router();

// `reports: 'off'` (or `?reports=off` on the page) keeps the failure but skips Sentry alerting/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = req => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');

function sendError(req, res, error, fallbackCode) {
  res.status(error.status || 500).json({
    success: false, error: error.message, errorClass: error.name, field: error.field,
    code: error.code || fallbackCode, reference: error.reference, requestId: req.requestId,
  });
}

router.get('/api/9dc8b009/catalog', (_req, res) => res.json(getCatalog()));

router.post('/api/9dc8b009/orders', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await placeOrder({
      modelId: body.modelId, paintId: body.paintId, wallbox: body.wallbox, household: body.household,
      suppressAlerts: alertsSuppressed(req),
    }));
  } catch (error) {
    sendError(req, res, error, 'ORDER_FAILED');
  }
});

router.get('/api/9dc8b009/orders/:orderId', (req, res) => {
  try {
    res.json(getOrder(req.params.orderId));
  } catch (error) {
    sendError(req, res, error, 'ORDER_LOOKUP_FAILED');
  }
});

module.exports = router;

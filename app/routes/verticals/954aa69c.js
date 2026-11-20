const express = require('express');
const {
  API_BASE,
  ROUTE,
  SERVICE,
  getBlotter,
  stageOrder,
  routeOrder,
  publicConfig,
} = require('../../services/verticals/954aa69c');

const router = express.Router();

router.use(API_BASE, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function sendError(res, req, error, fallbackCode) {
  const status = error.statusCode || 500;
  res.status(status).json({
    success: false,
    error: error.publicMessage || (status < 500 ? error.message : 'Request could not be processed.'),
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get(`${API_BASE}/health`, (_req, res) => res.json({ ok: true, service: SERVICE }));

router.get(`${API_BASE}/config`, (_req, res) => res.json(publicConfig()));

router.get(`${API_BASE}/blotter`, (_req, res) => res.json(getBlotter()));

router.post(`${API_BASE}/orders`, (req, res) => {
  try {
    res.status(201).json(stageOrder(req.body));
  } catch (error) {
    sendError(res, req, error, 'STAGE_FAILED');
  }
});

router.post(ROUTE, async (req, res) => {
  try {
    res.status(201).json(await routeOrder(req.body));
  } catch (error) {
    sendError(res, req, error, 'ROUTE_FAILED');
  }
});

router.all(`${API_BASE}/{*splat}`, (_req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found.', code: 'NOT_FOUND' });
});

module.exports = router;

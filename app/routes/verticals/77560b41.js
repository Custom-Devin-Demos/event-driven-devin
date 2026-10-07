const express = require('express');
const path = require('path');
const {
  REGIONS,
  getCatalog,
  getDeliveryWindows,
  checkout,
  getOpsSummary,
} = require('../../services/verticals/77560b41');

const router = express.Router();
const opsPage = path.join(__dirname, '../../public/verticals/77560b41/ops.html');

function sendValidationError(error, requestId) {
  return {
    success: false,
    error: error.message,
    errorClass: error.name || 'Error',
    code: error.code || 'CHECKOUT_FAILED',
    requestId,
  };
}

router.get('/api/77560b41/catalog', (req, res) => {
  const region = req.query.region;
  if (region && !REGIONS[region]) {
    const error = new Error(`Unknown delivery region: ${region}`);
    error.name = 'ValidationError';
    error.code = 'UNKNOWN_REGION';
    return res.status(400).json(sendValidationError(error, req.requestId));
  }
  res.json(getCatalog(region));
});

router.get('/api/77560b41/delivery-windows', (req, res) => {
  const windows = getDeliveryWindows(req.query.region);
  if (!windows.length) {
    const error = new Error(`Unknown delivery region: ${req.query.region}`);
    error.name = 'ValidationError';
    error.code = 'UNKNOWN_REGION';
    return res.status(400).json(sendValidationError(error, req.requestId));
  }
  res.json({ region: req.query.region, windows });
});

router.post('/api/77560b41/checkout', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await checkout(body, { requestId: req.requestId }));
  } catch (error) {
    res.status(error.status || 500).json(sendValidationError(error, req.requestId));
  }
});

router.get('/api/77560b41/ops/summary', (_req, res) => {
  res.json(getOpsSummary());
});

router.get('/misfits/ops', (_req, res) => res.sendFile(opsPage));
router.get('/77560b41/ops', (_req, res) => res.sendFile(opsPage));

module.exports = router;

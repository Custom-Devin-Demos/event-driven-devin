const express = require('express');
const logger = require('../../telemetry/logger');
const {
  submitContactRequest, PRODUCTS, PREFILL, LATENCY_SLO,
} = require('../../services/verticals/7137d615');

const router = express.Router();

router.get('/api/7137d615/config', (_req, res) => {
  res.json({ success: true, products: PRODUCTS, prefill: PREFILL, budgetMs: LATENCY_SLO.budgetMs });
});

router.post('/api/7137d615/contact-requests', async (req, res) => {
  try {
    res.json(await submitContactRequest(req.body || {}));
  } catch (error) {
    const invalid = error.name === 'ValidationError';
    if (!invalid) logger.error('Octaura contact request failed', { requestId: req.requestId, error: error.message });
    res.status(invalid ? 400 : 500).json({
      success: false,
      error: invalid ? error.message : 'Unable to submit. Please try again.',
      errorClass: invalid ? 'ValidationError' : 'Error',
      code: invalid ? error.code : 'CONTACT_REQUEST_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

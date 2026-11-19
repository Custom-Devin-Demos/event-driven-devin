const express = require('express');
const {
  API_BASE, ROUTE, FEEDBACK_ROUTE, SERVICE, getAuctions, submitBid, submitFeedback, publicConfig,
} = require('../../services/verticals/5e2f9a41');

const router = express.Router();

router.use(API_BASE, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get(`${API_BASE}/health`, (_req, res) => res.json({ ok: true, service: SERVICE }));
router.get(`${API_BASE}/config`, (_req, res) => res.json(publicConfig()));
router.get(`${API_BASE}/auctions`, (_req, res) => res.json(getAuctions()));

router.post(ROUTE, async (req, res) => {
  try {
    res.status(201).json(await submitBid(req.body));
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.publicMessage || (status < 500 ? error.message : 'Request could not be processed.'),
      code: error.code || 'BID_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

router.post(FEEDBACK_ROUTE, async (req, res) => {
  try {
    res.json(await submitFeedback(req.body));
  } catch (error) {
    const known = error.code === 'FEEDBACK_REJECTED';
    res.status(known ? error.statusCode : 500).json({
      success: false,
      error: known ? error.message : 'Request could not be processed.',
      code: known ? error.code : 'FEEDBACK_FAILED',
    });
  }
});

router.all(`${API_BASE}/{*splat}`, (_req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found.', code: 'NOT_FOUND' });
});

module.exports = router;

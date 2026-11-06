const express = require('express');
const {
  getForm, listMarkets, login, selectCard, validateStep, submit,
} = require('../../services/verticals/526efb4c');

const router = express.Router();
const MARKET_CODE = /^[A-Za-z]{2}$/;

function send(res, result) {
  const { status, ...body } = result;
  if (status >= 400) return res.status(status).json({ success: false, ...body });
  return res.status(status).json({ success: true, ...body });
}

function notAvailable(res, market) {
  return res.status(404).json({
    success: false,
    code: 'MARKET_NOT_AVAILABLE',
    error: `KYC is not yet available for market ${market}`,
    market,
    availableMarkets: listMarkets(),
  });
}

router.get('/api/526efb4c/form', (req, res) => {
  const market = String(req.query.market || 'US').trim().toUpperCase();
  if (!MARKET_CODE.test(market)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: 'market must be a 2-letter country code' });
  }
  const form = getForm(market);
  if (!form) return notAvailable(res, market);
  return res.json({ success: true, form });
});

router.post('/api/526efb4c/session', (req, res) => send(res, login(req.body || {})));

router.post('/api/526efb4c/session/card', (req, res) => send(res, selectCard(req.body || {})));

router.post('/api/526efb4c/steps/:stepId/validate', (req, res) => {
  const body = req.body || {};
  const market = String(body.market || 'US').trim().toUpperCase();
  if (!MARKET_CODE.test(market)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: 'market must be a 2-letter country code' });
  }
  if (!getForm(market)) return notAvailable(res, market);
  const result = validateStep(market, req.params.stepId, body.values);
  if (!result) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'Unknown step' });
  return res.json({ success: true, ...result });
});

router.post('/api/526efb4c/submissions', (req, res) => send(res, submit(req.body || {})));

module.exports = router;

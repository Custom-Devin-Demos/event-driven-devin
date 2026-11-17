const express = require('express');
const { PURPOSES, TRACKS, MIXES, PRIME_RATE, requestOffer, getOffer } = require('../../services/verticals/c5d1587d');

const router = express.Router();

// `reports: 'off'` (or `?reports=off` on the page) keeps the failure but skips Sentry alerting/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = req => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');
const str = v => (typeof v === 'string' && v ? v : undefined);

function sendError(req, res, error, fallbackCode) {
  res.status(error.status || 500).json({
    success: false, error: error.message, errorClass: error.name, field: error.field,
    code: error.code || fallbackCode, reference: error.reference, requestId: req.requestId,
  });
}

router.get('/api/c5d1587d/catalog', (_req, res) => res.json({ purposes: PURPOSES, tracks: TRACKS, mixes: MIXES, primeRate: PRIME_RATE }));

router.post('/api/c5d1587d/mortgage-offers', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await requestOffer({
      application: body.application, suppressAlerts: alertsSuppressed(req),
      devinUserId: str(body.devinUserId), devinOrgId: str(body.devinOrgId), devinEmail: str(body.devinEmail),
    }));
  } catch (error) {
    sendError(req, res, error, 'MORTGAGE_OFFER_FAILED');
  }
});

router.get('/api/c5d1587d/mortgage-offers/:offerId', (req, res) => {
  try {
    res.json(getOffer(req.params.offerId));
  } catch (error) {
    sendError(req, res, error, 'OFFER_LOOKUP_FAILED');
  }
});

module.exports = router;

const express = require('express');
const svc = require('../../services/verticals/128703d6');

const router = express.Router();

const demoIdOf = req => req.get('x-demo-id') || (req.body && req.body.demoId) || req.query.demoId;
const signerOf = req => (req.body && req.body.signerName) || req.query.signer;
// `reports: 'off'` (or `?reports=off` on the page) keeps the planted failure but skips Sentry/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = req => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');
const str = v => (typeof v === 'string' && v ? v : undefined);

function handle(fn) {
  return (req, res) => {
    try {
      res.json({ success: true, envelope: fn(req) });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false, error: error.publicMessage || error.message, errorClass: error.name,
        code: error.code || 'ENVELOPE_REQUEST_FAILED', missing: error.missing, reference: error.reference, requestId: req.requestId,
      });
    }
  };
}

router.get('/api/128703d6/envelope', handle(req => svc.getEnvelope(demoIdOf(req), { signerName: signerOf(req) })));
router.post('/api/128703d6/envelope/view', handle(req => svc.markViewed(demoIdOf(req), { signerName: signerOf(req) })));
router.post('/api/128703d6/envelope/complete', handle(req => {
  const body = req.body || {};
  return svc.completeEnvelope(demoIdOf(req), {
    values: body.values, signature: body.signature, suppressAlerts: alertsSuppressed(req),
    devinUserId: str(body.devinUserId), devinOrgId: str(body.devinOrgId), devinEmail: str(body.devinEmail),
  });
}));
router.post('/api/128703d6/envelope/reset', handle(req => svc.resetEnvelope(demoIdOf(req), { signerName: signerOf(req) })));

module.exports = router;

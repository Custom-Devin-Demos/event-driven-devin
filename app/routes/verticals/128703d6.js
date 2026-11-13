const express = require('express');
const svc = require('../../services/verticals/128703d6');

const router = express.Router();

const demoIdOf = req => req.get('x-demo-id') || (req.body && req.body.demoId) || req.query.demoId;
const signerOf = req => (req.body && req.body.signerName) || req.query.signer;

function handle(fn) {
  return (req, res) => {
    try {
      res.json({ success: true, envelope: fn(req) });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false, error: error.message, errorClass: error.name,
        code: error.code || 'ENVELOPE_REQUEST_FAILED', missing: error.missing, requestId: req.requestId,
      });
    }
  };
}

router.get('/api/128703d6/envelope', handle(req => svc.getEnvelope(demoIdOf(req), { signerName: signerOf(req) })));
router.post('/api/128703d6/envelope/view', handle(req => svc.markViewed(demoIdOf(req), { signerName: signerOf(req) })));
router.post('/api/128703d6/envelope/complete', handle(req => svc.completeEnvelope(demoIdOf(req), { values: req.body && req.body.values, signature: req.body && req.body.signature })));
router.post('/api/128703d6/envelope/reset', handle(req => svc.resetEnvelope(demoIdOf(req), { signerName: signerOf(req) })));

module.exports = router;

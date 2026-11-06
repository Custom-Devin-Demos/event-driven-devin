const express = require('express');
const { ROUTE, validateReport, reportIncident } = require('../../services/verticals/f2ec3d90');

const router = express.Router();

// This server-to-server bridge uses the native report bridges' 202/400/429 contract.
router.post(ROUTE, (req, res) => {
  if (!validateReport(req.body)) {
    return res.status(400).json({ received: false, status: 'rejected', error: 'Expected complete f2ec3d90 incident evidence with HTTP status 500–599' });
  }
  const result = reportIncident(req.body);
  if (result.status === 'throttled') {
    res.set('Retry-After', String(result.retryAfter));
    return res.status(429).json({ received: false, ...result });
  }
  return res.status(202).json({ received: true, status: result.status, reference: result.reference, sessionRequested: result.sessionRequested });
});

module.exports = router;

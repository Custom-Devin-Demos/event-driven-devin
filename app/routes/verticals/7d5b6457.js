const express = require('express');
const path = require('path');
const { submitEnforcementRequest, getTenant, applicantProfile } = require('../../services/verticals/7d5b6457');

const router = express.Router();

const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', '7d5b6457.html');

function sendPage(_req, res) {
  res.sendFile(PAGE);
}

async function handleSubmit(req, res) {
  const body = req.body || {};

  try {
    const result = await submitEnforcementRequest({
      tenant: req.params.tenant,
      instrumentId: body.instrumentId,
      requestType: body.requestType,
      amount: body.amount,
      details: body.details,
      acknowledged: body.acknowledged,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ENFORCEMENT_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
}

// Every demo owner gets their own unlisted URL: /7d5b6457/<tenant>. The bare
// slug is served by the vertical registry but carries no tenant, so its form
// refuses to submit rather than running against someone else's demo state.
router.get('/7d5b6457/:tenant', (req, res, next) => {
  if (!getTenant(req.params.tenant)) return next();
  sendPage(req, res);
});

router.get('/api/7d5b6457/:tenant/applicant', (req, res) => {
  const applicant = applicantProfile(req.params.tenant);
  if (!applicant) return res.status(404).json({ success: false, code: 'UNKNOWN_TENANT' });
  return res.json({ success: true, applicant });
});

router.post('/api/7d5b6457/:tenant/enforcement-requests', handleSubmit);

module.exports = router;

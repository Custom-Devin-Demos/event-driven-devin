const express = require('express');
const { listClaims, getClaim, runPayerRules, submitToCarrier } = require('../../services/verticals/f6f40dd7');

const router = express.Router();

function sendError(req, res, error, fallbackCode) {
  const payload = {
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: req.requestId,
  };
  if (error.accountId) payload.accountId = error.accountId;
  if (error.rulesCompleted) payload.rulesCompleted = error.rulesCompleted;
  res.status(error.statusCode || 500).json(payload);
}

router.get('/api/f6f40dd7/claims', (_req, res) => {
  res.json(listClaims());
});

router.get('/api/f6f40dd7/claims/:accountId', (req, res) => {
  try {
    res.json({ success: true, claim: getClaim(req.params.accountId) });
  } catch (error) {
    sendError(req, res, error, 'CLAIM_LOOKUP_FAILED');
  }
});

router.post('/api/f6f40dd7/payer-rules/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runPayerRules({
      accountId: body.accountId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    sendError(req, res, error, 'PAYER_RULES_FAILED');
  }
});

router.post('/api/f6f40dd7/claims/:accountId/submit', async (req, res) => {
  try {
    const result = await submitToCarrier({ accountId: req.params.accountId });
    res.json(result);
  } catch (error) {
    sendError(req, res, error, 'CARRIER_SUBMIT_FAILED');
  }
});

module.exports = router;

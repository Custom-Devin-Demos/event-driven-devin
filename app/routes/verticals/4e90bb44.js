const express = require('express');
const {
  applySavings,
  publicClient,
  CLIENTS,
  SAVINGS_TIERS,
  DEFAULT_CLIENT_ID,
} = require('../../services/verticals/4e90bb44');

const router = express.Router();

// Reproduction mode lets a remediation session fail the request on camera without
// re-raising the incident it was created from. It is ignored in production, so the
// header cannot silence a real failure on the hosted demo.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/rocket-companies/offer', (_req, res) => {
  res.json({
    tiers: Object.values(SAVINGS_TIERS).map(({ id, label, maxSavings }) => ({ id, label, maxSavings })),
    clients: Object.values(CLIENTS).map(publicClient),
    defaultClientId: DEFAULT_CLIENT_ID,
  });
});

router.post('/api/rocket-companies/savings/apply', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await applySavings({
      clientId: body.clientId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_REQUEST',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'SAVINGS_APPLY_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;

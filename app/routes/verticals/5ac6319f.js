const express = require('express');
const {
  runTaxAuthorityStatus,
  TAX_AUTHORITIES,
  SCOPE_OPTIONS,
  DOCUMENTS,
} = require('../../services/verticals/5ac6319f');

const router = express.Router();

router.get('/api/5ac6319f/options', (_req, res) => {
  res.json({
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      authorityCount: option.authorities.length,
    })),
    authorities: Object.entries(TAX_AUTHORITIES).map(([key, authority]) => ({
      key,
      country: authority.country,
      countryCode: authority.countryCode,
      authority: authority.authority,
      format: authority.format,
      mandate: authority.mandate,
    })),
  });
});

router.get('/api/5ac6319f/documents', (_req, res) => {
  res.json({ documents: DOCUMENTS });
});

router.post('/api/5ac6319f/tax-authority-status', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await runTaxAuthorityStatus({
      scope: body.scope,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TAX_STATUS_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

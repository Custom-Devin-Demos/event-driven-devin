const express = require('express');
const {
  runAuditReadiness,
  SITES,
  SCOPE_OPTIONS,
  ASSET_CLASSES,
} = require('../../services/verticals/3c9e1f7a');

const router = express.Router();

router.get('/api/3c9e1f7a/options', (_req, res) => {
  res.json({
    sites: Object.entries(SITES).map(([key, site]) => ({
      key,
      label: site.label,
    })),
    scopeOptions: Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      classCount: option.classes.length,
    })),
    assetClasses: Object.entries(ASSET_CLASSES).map(([key, assetClass]) => ({
      key,
      label: assetClass.label,
      system: assetClass.system,
    })),
  });
});

router.post('/api/3c9e1f7a/audit-readiness', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runAuditReadiness({
      site: body.site,
      scope: body.scope,
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
      code: error.code || 'AUDIT_READINESS_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

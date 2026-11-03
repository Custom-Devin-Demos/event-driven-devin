const express = require('express');
const {
  runCompressionPreview,
  COUNTERPARTIES,
  COUNTERPARTY_SCOPES,
  ASSET_CLASSES,
} = require('../../services/verticals/a6fe3aeb');

const router = express.Router();

router.get('/api/a6fe3aeb/counterparties', (req, res) => {
  res.json({
    counterparties: Object.entries(COUNTERPARTIES).map(([key, cp]) => ({
      key,
      label: cp.label,
      region: cp.region,
    })),
    scopeOptions: Object.entries(COUNTERPARTY_SCOPES).map(([key, option]) => ({
      key,
      label: option.label,
      counterpartyCount: option.counterparties.length,
    })),
    assetClasses: Object.entries(ASSET_CLASSES).map(([key, ac]) => ({ key, label: ac.label })),
  });
});

router.post('/api/a6fe3aeb/compression-preview', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runCompressionPreview({
      name: body.name,
      institution: body.institution,
      email: body.email,
      assetClass: body.assetClass,
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
      code: error.code || 'COMPRESSION_PREVIEW_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;

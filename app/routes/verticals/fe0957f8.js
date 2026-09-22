const express = require('express');
const {
  publishDataProduct,
  ASSETS,
  CERTIFICATIONS,
  DOMAINS,
  MAX_PRODUCT_NAME,
  MAX_PUBLISHED_BY,
} = require('../../services/verticals/fe0957f8');

const router = express.Router();

router.get('/api/fe0957f8/assets', (_req, res) => {
  res.json({
    assets: Object.entries(ASSETS).map(([assetId, a]) => ({
      assetId,
      qualifiedName: a.qualifiedName,
      displayName: a.displayName,
      source: a.source,
      database: a.database,
      schema: a.schema,
      assetType: a.assetType,
      assetTypeLabel: a.assetTypeLabel,
      rowCount: a.rowCount,
      columns: a.columns,
      classifications: a.classifications,
      glossaryTerms: a.glossaryTerms,
      downstreamAssets: a.downstreamAssets,
      dashboards: a.dashboards,
      popularity: a.popularity,
      lastRun: a.lastRun,
    })),
    certifications: Object.values(CERTIFICATIONS).map((c) => ({ code: c.code, label: c.label, slaDays: c.slaDays })),
    domains: Object.values(DOMAINS).map((d) => ({ code: d.code, label: d.label, steward: d.steward, policyPack: d.policyPack })),
  });
});

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

router.post('/api/fe0957f8/publish', async (req, res) => {
  const body = req.body || {};
  const productName = typeof body.productName === 'string' ? body.productName.trim() : '';
  const publishedBy = typeof body.publishedBy === 'string' ? body.publishedBy.trim() : '';
  const assetId = stringField(body.assetId, 'snowflake/finance/dp_revenue_daily');
  const certification = stringField(body.certification, 'verified');
  const domain = stringField(body.domain, 'finance');

  if (!productName || productName.length > MAX_PRODUCT_NAME) {
    return res.status(400).json({
      success: false,
      error: `productName is required and must be at most ${MAX_PRODUCT_NAME} characters`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!publishedBy || publishedBy.length > MAX_PUBLISHED_BY) {
    return res.status(400).json({
      success: false,
      error: `publishedBy is required and must be at most ${MAX_PUBLISHED_BY} characters`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!has(ASSETS, assetId)) {
    return res.status(400).json({ success: false, error: `Unknown catalog asset: ${assetId}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(CERTIFICATIONS, certification)) {
    return res.status(400).json({ success: false, error: `Unknown certification level: ${certification}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(DOMAINS, domain)) {
    return res.status(400).json({ success: false, error: `Unknown domain: ${domain}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await publishDataProduct({
      productName,
      publishedBy,
      assetId,
      certification,
      domain,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DATA_PRODUCT_PUBLISH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;

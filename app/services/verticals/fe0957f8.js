/**
 * Atlan — data product publishing in the metadata catalog.
 *
 * Models the catalog workflow that turns a governed asset into a published
 * data product: classification propagation is resolved for the asset type,
 * a lineage impact summary is built from the downstream graph, and policy
 * checks plus linked glossary terms are attached to the published contract.
 *
 * Intentional demo defect: `dynamic_table` was added to the asset registry
 * when Snowflake dynamic tables became a supported source type, but
 * `PROPAGATION_RULES` was never extended for it. `resolvePropagationRules()`
 * therefore returns `undefined` and `buildLineageImpact()` crashes reading
 * `.downstreamHops` off it.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-fe0957f8-atlan-catalog';
const ROUTE = '/api/fe0957f8/publish';
const SLACK_MEMBER_ID = process.env.ATLAN_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Governed assets available for publication in the catalog.
 */
const ASSETS = {
  'snowflake/finance/dp_revenue_daily': {
    qualifiedName: 'snowflake/finance/DP_REVENUE_DAILY',
    displayName: 'DP_REVENUE_DAILY',
    source: 'Snowflake',
    database: 'FINANCE',
    schema: 'REPORTING',
    assetType: 'dynamic_table',
    assetTypeLabel: 'Dynamic Table',
    rowCount: 48210934,
    columns: 34,
    classifications: ['PII', 'Financially Sensitive'],
    glossaryTerms: ['Net Revenue', 'Booked ARR', 'Fiscal Period'],
    downstreamAssets: 41,
    dashboards: 12,
    popularity: 'High',
    lastRun: '2026-09-22T04:15:00Z',
  },
  'snowflake/finance/fct_invoice_line': {
    qualifiedName: 'snowflake/finance/FCT_INVOICE_LINE',
    displayName: 'FCT_INVOICE_LINE',
    source: 'Snowflake',
    database: 'FINANCE',
    schema: 'CORE',
    assetType: 'table',
    assetTypeLabel: 'Table',
    rowCount: 219884012,
    columns: 52,
    classifications: ['Financially Sensitive'],
    glossaryTerms: ['Invoice Line', 'Net Revenue'],
    downstreamAssets: 27,
    dashboards: 8,
    popularity: 'High',
    lastRun: '2026-09-22T03:40:00Z',
  },
  'snowflake/marketing/vw_campaign_attribution': {
    qualifiedName: 'snowflake/marketing/VW_CAMPAIGN_ATTRIBUTION',
    displayName: 'VW_CAMPAIGN_ATTRIBUTION',
    source: 'Snowflake',
    database: 'MARKETING',
    schema: 'ANALYTICS',
    assetType: 'view',
    assetTypeLabel: 'View',
    rowCount: 3120448,
    columns: 21,
    classifications: ['Internal'],
    glossaryTerms: ['Attributed Pipeline', 'Campaign'],
    downstreamAssets: 14,
    dashboards: 6,
    popularity: 'Medium',
    lastRun: '2026-09-21T22:05:00Z',
  },
  'databricks/product/mv_active_workspaces': {
    qualifiedName: 'databricks/product/MV_ACTIVE_WORKSPACES',
    displayName: 'MV_ACTIVE_WORKSPACES',
    source: 'Databricks',
    database: 'PRODUCT',
    schema: 'GOLD',
    assetType: 'materialized_view',
    assetTypeLabel: 'Materialized View',
    rowCount: 884210,
    columns: 18,
    classifications: ['Internal'],
    glossaryTerms: ['Active Workspace', 'Weekly Active Team'],
    downstreamAssets: 9,
    dashboards: 4,
    popularity: 'Medium',
    lastRun: '2026-09-22T01:10:00Z',
  },
  'kafka/platform/stream_usage_events': {
    qualifiedName: 'kafka/platform/STREAM_USAGE_EVENTS',
    displayName: 'STREAM_USAGE_EVENTS',
    source: 'Kafka',
    database: 'PLATFORM',
    schema: 'EVENTS',
    assetType: 'stream',
    assetTypeLabel: 'Stream',
    rowCount: 1904223871,
    columns: 12,
    classifications: ['Internal'],
    glossaryTerms: ['Usage Event'],
    downstreamAssets: 19,
    dashboards: 3,
    popularity: 'High',
    lastRun: '2026-09-22T06:02:00Z',
  },
};

/**
 * Classification-propagation rules by asset type. Every supported asset type
 * needs a row here before it can be published as a data product.
 * BUG: `dynamic_table` is a supported asset type (see ASSETS) but has no row,
 * so lookups for it resolve `undefined`.
 */
const PROPAGATION_RULES = {
  table: {
    downstreamHops: 3,
    propagateClassifications: true,
    propagateGlossaryTerms: true,
    lineageRefresh: 'on_write',
    policyEngine: 'column-level masking',
  },
  view: {
    downstreamHops: 2,
    propagateClassifications: true,
    propagateGlossaryTerms: true,
    lineageRefresh: 'on_query',
    policyEngine: 'row-level filters',
  },
  materialized_view: {
    downstreamHops: 2,
    propagateClassifications: true,
    propagateGlossaryTerms: false,
    lineageRefresh: 'on_refresh',
    policyEngine: 'column-level masking',
  },
  stream: {
    downstreamHops: 1,
    propagateClassifications: true,
    propagateGlossaryTerms: false,
    lineageRefresh: 'continuous',
    policyEngine: 'topic ACLs',
  },
};

const CERTIFICATIONS = {
  draft: { code: 'draft', label: 'Draft', reviewers: ['Domain Steward'], slaDays: 5 },
  verified: { code: 'verified', label: 'Verified', reviewers: ['Domain Steward', 'Data Governance Council'], slaDays: 2 },
};

const DOMAINS = {
  finance: { code: 'finance', label: 'Finance', steward: 'Priya Raghavan', policyPack: 'SOX + PII' },
  marketing: { code: 'marketing', label: 'Marketing', steward: 'Daniel Okonkwo', policyPack: 'PII' },
  product: { code: 'product', label: 'Product Analytics', steward: 'Mei Lin', policyPack: 'Internal' },
  platform: { code: 'platform', label: 'Platform', steward: 'Tomas Alvarez', policyPack: 'Internal' },
};

const MAX_PRODUCT_NAME = 120;

function resolveAsset(assetId) {
  const asset = ASSETS[assetId];
  if (!asset) {
    throw Object.assign(new Error(`Unknown catalog asset: ${assetId}`), { code: 'INVALID_ASSET' });
  }
  return asset;
}

/**
 * Looks up the classification-propagation rules registered for an asset type.
 */
function resolvePropagationRules(assetType) {
  return PROPAGATION_RULES[assetType];
}

/**
 * Builds the lineage impact summary shown on the publish confirmation.
 * BUG: PROPAGATION_RULES has no dynamic_table row, so `rules.downstreamHops`
 * throws a TypeError for the default Snowflake dynamic table.
 */
function buildLineageImpact(asset, certification) {
  const rules = resolvePropagationRules(asset.assetType);
  const hops = rules.downstreamHops;
  const propagatedAssets = Math.round(asset.downstreamAssets * (hops / 3));
  return {
    downstreamHops: hops,
    downstreamAssets: asset.downstreamAssets,
    propagatedAssets,
    dashboardsImpacted: asset.dashboards,
    lineageRefresh: rules.lineageRefresh,
    classificationsPropagated: rules.propagateClassifications ? asset.classifications : [],
    glossaryTermsPropagated: rules.propagateGlossaryTerms ? asset.glossaryTerms : [],
    policyEngine: rules.policyEngine,
    reviewers: certification.reviewers,
  };
}

function buildPolicyChecks(asset, domain, certification) {
  return [
    {
      name: 'Ownership assigned',
      status: 'passed',
      detail: `${domain.label} domain · steward ${domain.steward}`,
    },
    {
      name: 'Classification coverage',
      status: asset.classifications.length ? 'passed' : 'warning',
      detail: asset.classifications.length
        ? `${asset.classifications.length} classification(s) applied`
        : 'No classifications applied to this asset',
    },
    {
      name: `Policy pack — ${domain.policyPack}`,
      status: 'passed',
      detail: 'Masking and access policies resolved for all downstream consumers',
    },
    {
      name: 'Certification review',
      status: certification.code === 'verified' ? 'passed' : 'pending',
      detail: certification.code === 'verified'
        ? 'Governance council sign-off recorded'
        : `Draft products are reviewed within ${certification.slaDays} business days`,
    },
  ];
}

/**
 * Publishes a governed asset as a data product in the catalog.
 */
async function publishDataProduct(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Publishing Atlan data product', {
    requestId,
    assetId: data.assetId,
    certification: data.certification,
    domain: data.domain,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 120));

    const asset = resolveAsset(data.assetId);
    const certification = CERTIFICATIONS[data.certification];
    const domain = DOMAINS[data.domain];
    const lineageImpact = buildLineageImpact(asset, certification);
    const policyChecks = buildPolicyChecks(asset, domain, certification);

    const duration = Date.now() - startTime;

    incrementMetric('data_product.publish.success', {
      route: ROUTE,
      assetType: asset.assetType,
      certification: certification.code,
      domain: domain.code,
    });
    recordTiming('data_product.publish.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      productName: data.productName,
      publishedBy: data.publishedBy,
      asset: {
        assetId: data.assetId,
        qualifiedName: asset.qualifiedName,
        displayName: asset.displayName,
        source: asset.source,
        database: asset.database,
        schema: asset.schema,
        assetType: asset.assetType,
        assetTypeLabel: asset.assetTypeLabel,
        rowCount: asset.rowCount,
        columns: asset.columns,
      },
      certification: { code: certification.code, label: certification.label },
      domain: { code: domain.code, label: domain.label, steward: domain.steward, policyPack: domain.policyPack },
      lineageImpact,
      policyChecks,
      glossaryTerms: asset.glossaryTerms,
      status: certification.code === 'verified' ? 'published_verified' : 'published_draft',
      nextStep: certification.code === 'verified'
        ? 'The data product is discoverable in the catalog and policies are enforced downstream.'
        : `Draft product is discoverable to the ${domain.label} domain and goes to review within ${certification.slaDays} business days.`,
      publishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('data_product.publish.failure', {
      route: ROUTE,
      errorClass: error.name,
      assetId: data.assetId,
      certification: data.certification,
    });
    recordTiming('data_product.publish.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Atlan data product publication failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      assetId: data.assetId,
      certification: data.certification,
      domain: data.domain,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'atlan-catalog-publish', alert_path: 'instant' },
      extra: {
        requestId,
        assetId: data.assetId,
        certification: data.certification,
        domain: data.domain,
        productName: data.productName,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fe0957f8.js \u2014 buildLineageImpact',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'fe0957f8',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Atlan \u2014 Data Product Publishing',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        assetId: data.assetId,
        certification: data.certification,
        domain: data.domain,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Atlan publish error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  publishDataProduct,
  resolveAsset,
  resolvePropagationRules,
  buildLineageImpact,
  buildPolicyChecks,
  ASSETS,
  PROPAGATION_RULES,
  CERTIFICATIONS,
  DOMAINS,
  MAX_PRODUCT_NAME,
};
